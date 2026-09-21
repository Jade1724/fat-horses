//! HTTP API handlers (SPEC.md §5, F11.1), independent of any HTTP framework.

use std::collections::HashMap;
use std::future::Future;

use chrono::{DateTime, Utc};
use domain::countries::{CountriesFile, Country};
use domain::geo::Geocoder;
use domain::matching::MatchKind;
use domain::session::{PickError, PickSession, PickStatus};
use domain::status::{Restaurant, Status};
use domain::store::{
    GeocodeCache, HISTORY_PAGE, PickStore, StoreError, VisitStore, record_skip, record_visit,
};
use domain::winner::WinReason;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::start::{StartError, StartInput, new_pick_id, start_pick};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Other,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: Method,
    /// Path after `/api`, e.g. `/picks/01J...`. May be percent-encoded.
    pub path: String,
    pub query: HashMap<String, String>,
    pub api_key: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

impl Response {
    fn ok(body: impl Serialize) -> Self {
        Self::with(200, body)
    }

    fn with(status: u16, body: impl Serialize) -> Self {
        Self {
            status,
            body: serde_json::to_value(body).unwrap_or(Value::Null),
        }
    }

    fn error(status: u16, code: &str, message: impl std::fmt::Display) -> Self {
        Self {
            status,
            body: json!({ "error": code, "message": message.to_string() }),
        }
    }
}

/// Starts the workflow for a stored pick (Step Functions in AWS, a task locally).
pub trait WorkflowStarter {
    fn start(&self, pick_id: &str) -> impl Future<Output = Result<(), String>> + Send;
}

pub struct Api<G, S, W> {
    pub geocoder: G,
    pub store: S,
    pub starter: W,
    pub countries: CountriesFile,
    pub api_key: String,
}

/// Compare secrets without an early exit on the first differing byte (F11.1).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Serialize)]
pub struct CountryView {
    pub iso2: String,
    pub name: String,
    pub flag: String,
}

impl From<&Country> for CountryView {
    fn from(c: &Country) -> Self {
        Self {
            iso2: c.iso2.clone(),
            name: c.name.clone(),
            flag: c.flag.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RunnerView {
    pub number: u32,
    pub horse: String,
    pub country: Option<CountryView>,
    pub scratched: bool,
}

#[derive(Debug, Serialize)]
pub struct RaceView {
    pub venue: String,
    pub race_number: u32,
    pub name: String,
    pub start_time: DateTime<Utc>,
    pub runners: Vec<RunnerView>,
}

#[derive(Debug, Serialize)]
pub struct WinnerView {
    pub number: u32,
    pub horse: Option<String>,
    pub country: Option<CountryView>,
    pub reason: WinReason,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tied: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct RestaurantView {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub address: Option<String>,
    pub cuisine: Vec<String>,
    #[serde(rename = "match")]
    pub kind: MatchKind,
    pub reason: Option<String>,
    pub status: Option<Status>,
    pub visit_count: u32,
    pub distance_m: f64,
}

#[derive(Debug, Serialize)]
pub struct LocationView {
    pub lat: f64,
    pub lon: f64,
    pub display_name: String,
    pub radius_m: u32,
}

/// `GET /picks/{id}` (§5).
#[derive(Debug, Serialize)]
pub struct PickView {
    pub pick_id: String,
    pub status: PickStatus,
    pub error: Option<PickError>,
    pub created_at: DateTime<Utc>,
    pub location: LocationView,
    pub world_complete: bool,
    pub race: Option<RaceView>,
    pub winner: Option<WinnerView>,
    pub restaurants: Vec<RestaurantView>,
    pub pick: Option<String>,
    /// The winning country's dishes, when nothing matched (F6.6).
    pub dishes: Option<Vec<String>>,
    pub llm_unavailable: bool,
}

#[derive(Debug, Default, Deserialize)]
struct VisitBody {
    restaurant: Option<VisitDetails>,
}

#[derive(Debug, Deserialize)]
struct VisitDetails {
    name: String,
    lat: f64,
    lon: f64,
    address: Option<String>,
    #[serde(default)]
    cuisine: Vec<String>,
    country_iso: String,
}

fn store_error(e: StoreError) -> Response {
    match e {
        StoreError::Conflict => Response::error(409, "conflict", e),
        StoreError::NotFound => Response::error(404, "not_found", e),
        StoreError::InvalidTransition(_) => Response::error(409, "invalid_transition", e),
        StoreError::Unavailable(_) => {
            tracing::error!(error = %e, "store unavailable");
            Response::error(503, "internal", "storage unavailable")
        }
    }
}

enum Route {
    StartPick,
    GetPick(String),
    Picked,
    Visit(String),
    Skip(String),
    Countries,
    History,
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

fn route(method: Method, path: &str) -> Option<Route> {
    let path = decode(path);
    let path = path.trim_end_matches('/');
    match method {
        Method::Get => match path {
            "/restaurants/picked" => Some(Route::Picked),
            "/countries" => Some(Route::Countries),
            "/history" => Some(Route::History),
            p => p
                .strip_prefix("/picks/")
                .filter(|id| !id.is_empty() && !id.contains('/'))
                .map(|id| Route::GetPick(id.to_string())),
        },
        Method::Post => {
            if path == "/picks" {
                return Some(Route::StartPick);
            }
            // Restaurant ids contain '/' (osm:node/1), so match from both ends.
            let rest = path.strip_prefix("/restaurants/")?;
            if let Some(id) = rest.strip_suffix("/visit") {
                (!id.is_empty()).then(|| Route::Visit(id.to_string()))
            } else if let Some(id) = rest.strip_suffix("/skip") {
                (!id.is_empty()).then(|| Route::Skip(id.to_string()))
            } else {
                None
            }
        }
        Method::Other => None,
    }
}

impl<G, S, W> Api<G, S, W>
where
    G: Geocoder + Sync,
    S: VisitStore + PickStore + GeocodeCache + Sync,
    W: WorkflowStarter + Sync,
{
    pub async fn handle(&self, req: Request, now: DateTime<Utc>) -> Response {
        let authorised = req
            .api_key
            .as_deref()
            .is_some_and(|k| constant_time_eq(k.as_bytes(), self.api_key.as_bytes()));
        if !authorised {
            return Response::error(401, "unauthorized", "missing or wrong x-api-key");
        }
        let Some(route) = route(req.method, &req.path) else {
            return Response::error(404, "not_found", "no such endpoint");
        };
        let result = match route {
            Route::StartPick => self.start(req.body.as_deref(), now).await,
            Route::GetPick(id) => self.get_pick(&id).await,
            Route::Picked => self
                .store
                .currently_picked()
                .await
                .map(Response::ok)
                .map_err(store_error),
            Route::Visit(id) => self.visit(&id, req.body.as_deref(), now).await,
            Route::Skip(id) => record_skip(&self.store, &id, now)
                .await
                .map(Response::ok)
                .map_err(store_error),
            Route::Countries => self.countries(&req.query).await,
            Route::History => self
                .store
                .history(req.query.get("cursor").cloned(), HISTORY_PAGE)
                .await
                .map(Response::ok)
                .map_err(store_error),
        };
        result.unwrap_or_else(|e| e)
    }

    async fn start(&self, body: Option<&str>, now: DateTime<Utc>) -> Result<Response, Response> {
        let input: StartInput = serde_json::from_str(body.unwrap_or("{}"))
            .map_err(|e| Response::error(422, "invalid_request", e))?;
        let session = start_pick(&self.geocoder, &self.store, input, new_pick_id(), now)
            .await
            .map_err(|e| match e {
                StartError::InvalidRequest(_) => Response::error(422, "invalid_request", e),
                StartError::AddressNotFound => Response::error(422, "address_not_found", e),
                StartError::GeocoderUnavailable(_) => {
                    tracing::error!(error = %e, "geocoder unavailable");
                    Response::error(503, "internal", "geocoder unavailable")
                }
            })?;
        self.store.put_pick(&session).await.map_err(store_error)?;
        if let Err(e) = self.starter.start(&session.pick_id).await {
            tracing::error!(error = %e, pick_id = %session.pick_id, "workflow start failed");
            let mut failed = session.clone();
            failed.fail(PickError::Internal);
            let _ = self.store.put_pick(&failed).await;
            return Err(Response::error(503, "internal", "could not start the pick"));
        }
        Ok(Response::with(202, json!({ "pick_id": session.pick_id })))
    }

    async fn get_pick(&self, id: &str) -> Result<Response, Response> {
        let session = self
            .store
            .get_pick(id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| Response::error(404, "not_found", "no such pick"))?;
        let view = self.pick_view(&session).await.map_err(store_error)?;
        Ok(Response::ok(view))
    }

    fn country_view(&self, iso2: &str) -> Option<CountryView> {
        self.countries.get(iso2).map(CountryView::from)
    }

    /// Build the §5 pick view, with each restaurant's current stored status.
    pub async fn pick_view(&self, s: &PickSession) -> Result<PickView, StoreError> {
        let race = match (&s.race, &s.card) {
            (Some(r), Some(card)) => Some(RaceView {
                venue: r.venue.clone(),
                race_number: r.race_number,
                name: r.name.clone(),
                start_time: r.start_time,
                runners: card
                    .entries
                    .iter()
                    .map(|e| RunnerView {
                        number: e.number,
                        horse: e.horse.clone(),
                        country: e.country_iso.as_deref().and_then(|c| self.country_view(c)),
                        scratched: e.scratched,
                    })
                    .collect(),
            }),
            _ => None,
        };
        let winner = s.winner.as_ref().map(|w| WinnerView {
            number: w.number,
            horse: s
                .card
                .as_ref()
                .and_then(|c| c.entry(w.number))
                .map(|e| e.horse.clone()),
            country: self.country_view(&w.country_iso),
            reason: w.reason,
            tied: w.tied.clone(),
        });
        let mut restaurants = Vec::new();
        for m in &s.matches {
            let Some(p) = s.places.iter().find(|p| p.id == m.place_id) else {
                continue;
            };
            let stored = self.store.get_restaurant(&p.id).await?;
            restaurants.push(RestaurantView {
                id: p.id.clone(),
                name: p.name.clone(),
                lat: p.lat,
                lon: p.lon,
                address: p.address.clone(),
                cuisine: p.cuisine.clone(),
                kind: m.kind,
                reason: m.reason.clone(),
                status: stored.as_ref().and_then(|r| r.status),
                visit_count: stored.as_ref().map_or(0, |r| r.visit_count),
                distance_m: p.distance_m,
            });
        }
        let dishes = match (&s.winner, s.status) {
            (Some(w), PickStatus::Done) if s.matches.is_empty() => {
                self.countries.get(&w.country_iso).map(|c| c.dishes.clone())
            }
            _ => None,
        };
        Ok(PickView {
            pick_id: s.pick_id.clone(),
            status: s.status,
            error: s.error,
            created_at: s.created_at,
            location: LocationView {
                lat: s.location.lat,
                lon: s.location.lon,
                display_name: s.location.display_name.clone(),
                radius_m: s.request.radius_m,
            },
            world_complete: s.world_complete,
            race,
            winner,
            restaurants,
            pick: s.pick.clone(),
            dishes,
            llm_unavailable: s.llm_unavailable,
        })
    }

    async fn visit(
        &self,
        id: &str,
        body: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Response, Response> {
        let body: VisitBody = match body.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => {
                serde_json::from_str(b).map_err(|e| Response::error(422, "invalid_request", e))?
            }
            None => VisitBody::default(),
        };
        let details = match body.restaurant {
            Some(d) => {
                if self.countries.get(&d.country_iso).is_none() {
                    return Err(Response::error(
                        422,
                        "invalid_request",
                        "unknown country_iso",
                    ));
                }
                Some(Restaurant {
                    id: id.to_string(),
                    name: d.name,
                    lat: d.lat,
                    lon: d.lon,
                    address: d.address,
                    cuisine: d.cuisine,
                    country_iso: d.country_iso,
                    status: None,
                    status_before_pick: None,
                    picked_at: None,
                    visited_at: None,
                    visit_count: 0,
                    pick_id: None,
                    kind: None,
                    reason: None,
                })
            }
            None => None,
        };
        record_visit(&self.store, id, details, now)
            .await
            .map(Response::ok)
            .map_err(|e| match e {
                StoreError::NotFound => Response::error(
                    422,
                    "invalid_request",
                    "restaurant details are required for a restaurant that was never picked",
                ),
                other => store_error(other),
            })
    }

    async fn countries(&self, query: &HashMap<String, String>) -> Result<Response, Response> {
        let min_population = match query.get("min_population") {
            Some(v) => v
                .parse()
                .map_err(|_| Response::error(422, "invalid_request", "bad min_population"))?,
            None => domain::pool::DEFAULT_MIN_POPULATION,
        };
        let visits = self.store.country_visits().await.map_err(store_error)?;
        let rows: Vec<Value> = self
            .countries
            .countries
            .iter()
            .filter(|c| c.population >= min_population)
            .map(|c| {
                let v = visits.iter().find(|v| v.iso2 == c.iso2);
                let count = v.map_or(0, |v| v.visit_count);
                json!({
                    "iso2": c.iso2,
                    "name": c.name,
                    "flag": c.flag,
                    "visited": count > 0,
                    "visit_count": count,
                    "last_visited_at": v.and_then(|v| v.last_visited_at),
                })
            })
            .collect();
        let visited = rows.iter().filter(|r| r["visited"] == true).count();
        Ok(Response::ok(json!({
            "visited": visited,
            "total": rows.len(),
            "countries": rows,
        })))
    }
}
