//! Overpass API places client (SPEC.md F6.1).

use std::collections::BTreeMap;

use domain::geo::distance_m;
use domain::places::{Place, Places, PlacesError, parse_cuisine};
use serde::Deserialize;

/// Public instances, tried in order. The main instance is sometimes overloaded.
pub const DEFAULT_ENDPOINTS: &[&str] = &[
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

/// OSM tags passed on to the classifier (SPEC.md L3). Public data only.
const KEPT_TAGS: &[&str] = &[
    "brand",
    "description",
    "menu",
    "website",
    "contact:website",
    "website:menu",
    "name:en",
    "diet:vegetarian",
    "diet:vegan",
    "diet:halal",
];

pub struct Overpass {
    http: reqwest::Client,
    endpoints: Vec<String>,
}

impl Overpass {
    /// `http` must already carry the app's User-Agent (see [`crate::http_client`]).
    pub fn new(http: reqwest::Client, endpoints: Vec<String>) -> Self {
        Self { http, endpoints }
    }

    async fn post(&self, endpoint: &str, query: &str) -> Result<String, String> {
        let resp = self
            .http
            .post(endpoint)
            .form(&[("data", query)])
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        resp.text().await.map_err(|e| e.to_string())
    }
}

/// The Overpass QL query for restaurant-like places within `radius_m` metres.
pub fn build_query(lat: f64, lon: f64, radius_m: u32, amenities: &[&str]) -> String {
    let alternation = amenities.join("|");
    format!(
        "[out:json][timeout:25];\
         nwr[\"amenity\"~\"^({alternation})$\"](around:{radius_m},{lat},{lon});\
         out center tags;"
    )
}

#[derive(Debug, Deserialize)]
struct Response {
    elements: Vec<Element>,
    /// Set when Overpass hit a runtime error but still returned JSON.
    remark: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Element {
    #[serde(rename = "type")]
    kind: String,
    id: u64,
    lat: Option<f64>,
    lon: Option<f64>,
    center: Option<Center>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct Center {
    lat: f64,
    lon: f64,
}

/// Parse an Overpass JSON response into places within `radius_m` of the origin,
/// nearest first. Elements without coordinates are dropped.
pub fn parse_response(
    body: &str,
    origin_lat: f64,
    origin_lon: f64,
    radius_m: u32,
) -> Result<Vec<Place>, PlacesError> {
    let resp: Response = serde_json::from_str(body).map_err(|e| {
        let snippet: String = body.chars().take(200).collect();
        PlacesError::Unavailable(format!("bad Overpass response ({e}): {snippet}"))
    })?;
    if let Some(remark) = resp.remark.filter(|r| r.contains("error")) {
        return Err(PlacesError::Unavailable(format!("Overpass: {remark}")));
    }
    let mut places: Vec<Place> = resp
        .elements
        .into_iter()
        .filter_map(|e| to_place(e, origin_lat, origin_lon))
        .filter(|p| p.distance_m <= f64::from(radius_m))
        .collect();
    places.sort_by(|a, b| a.distance_m.total_cmp(&b.distance_m));
    Ok(places)
}

fn to_place(e: Element, origin_lat: f64, origin_lon: f64) -> Option<Place> {
    let (lat, lon) = match (e.lat, e.lon, &e.center) {
        (Some(lat), Some(lon), _) => (lat, lon),
        (_, _, Some(c)) => (c.lat, c.lon),
        _ => return None,
    };
    let amenity = e.tags.get("amenity").cloned().unwrap_or_default();
    let name = e
        .tags
        .get("name")
        .cloned()
        .unwrap_or_else(|| format!("Unnamed {}", amenity.replace('_', " ")));
    let cuisine = e
        .tags
        .get("cuisine")
        .map(|c| parse_cuisine(c))
        .unwrap_or_default();
    let tags = KEPT_TAGS
        .iter()
        .filter_map(|k| e.tags.get(*k).map(|v| (k.to_string(), v.clone())))
        .collect();
    Some(Place {
        id: Place::osm_id(&e.kind, e.id),
        name,
        lat,
        lon,
        address: address(&e.tags),
        amenity,
        cuisine,
        tags,
        distance_m: distance_m(origin_lat, origin_lon, lat, lon),
    })
}

fn address(tags: &BTreeMap<String, String>) -> Option<String> {
    let street = match (tags.get("addr:housenumber"), tags.get("addr:street")) {
        (Some(n), Some(s)) => Some(format!("{n} {s}")),
        (None, Some(s)) => Some(s.clone()),
        _ => None,
    };
    let parts: Vec<String> = [
        street,
        tags.get("addr:suburb").cloned(),
        tags.get("addr:city").cloned(),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

impl Places for Overpass {
    async fn nearby(
        &self,
        lat: f64,
        lon: f64,
        radius_m: u32,
        amenities: &[&str],
    ) -> Result<Vec<Place>, PlacesError> {
        let query = build_query(lat, lon, radius_m, amenities);
        let mut errors = Vec::new();
        for endpoint in &self.endpoints {
            let result = match self.post(endpoint, &query).await {
                Ok(body) => parse_response(&body, lat, lon, radius_m).map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            match result {
                Ok(places) => return Ok(places),
                Err(e) => {
                    tracing::warn!(endpoint, error = %e, "Overpass endpoint failed");
                    errors.push(format!("{endpoint}: {e}"));
                }
            }
        }
        Err(PlacesError::Unavailable(errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HAND_WRITTEN: &str = include_str!("../tests/fixtures/overpass/hand_written.json");
    const RUNTIME_ERROR: &str = include_str!("../tests/fixtures/overpass/runtime_error.html");
    const ORIGIN: (f64, f64) = (-36.848_463_2, 174.762_183);

    fn parse(radius: u32) -> Vec<Place> {
        parse_response(HAND_WRITTEN, ORIGIN.0, ORIGIN.1, radius).unwrap()
    }

    #[test]
    fn query_text() {
        assert_eq!(
            build_query(-36.8, 174.7, 200, &["restaurant", "fast_food"]),
            "[out:json][timeout:25];\
             nwr[\"amenity\"~\"^(restaurant|fast_food)$\"](around:200,-36.8,174.7);\
             out center tags;"
        );
    }

    #[test]
    fn parses_nodes_ways_and_relations_nearest_first() {
        let places = parse(200);
        let ids: Vec<&str> = places.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "osm:relation/3005",
                "osm:node/1004",
                "osm:node/1001",
                "osm:node/1003",
                "osm:way/2002"
            ]
        );
        assert!(
            places
                .windows(2)
                .all(|w| w[0].distance_m <= w[1].distance_m)
        );
    }

    #[test]
    fn drops_places_outside_the_radius_and_without_geometry() {
        let places = parse(200);
        assert!(places.iter().all(|p| p.name != "Too Far"));
        assert!(places.iter().all(|p| p.name != "No Geometry"));
        let wide = parse(5000);
        assert!(wide.iter().any(|p| p.name == "Too Far"));
    }

    #[test]
    fn maps_fields() {
        let places = parse(200);
        let sakura = places.iter().find(|p| p.id == "osm:node/1001").unwrap();
        assert_eq!(sakura.name, "Sakura Sushi");
        assert_eq!(sakura.amenity, "restaurant");
        assert_eq!(sakura.cuisine, ["japanese", "sushi"]);
        assert_eq!(
            sakura.address.as_deref(),
            Some("12 Victoria Street West, Auckland")
        );
        assert_eq!(
            sakura.tags.get("website").map(String::as_str),
            Some("https://example.com/sakura")
        );
        assert!(
            !sakura.tags.contains_key("opening_hours"),
            "only kept tags pass through"
        );

        let taco = places.iter().find(|p| p.id == "osm:way/2002").unwrap();
        assert_eq!((taco.lat, taco.lon), (-36.8490, 174.7615));
        assert_eq!(taco.amenity, "fast_food");

        let chalet = places.iter().find(|p| p.id == "osm:node/1003").unwrap();
        assert!(chalet.cuisine.is_empty());
        assert!(!chalet.is_tagged());
        assert_eq!(
            chalet.tags.get("description").map(String::as_str),
            Some("Fondue and raclette")
        );

        let unnamed = places.iter().find(|p| p.id == "osm:node/1004").unwrap();
        assert_eq!(unnamed.name, "Unnamed restaurant");
        assert_eq!(unnamed.address, None);
    }

    #[test]
    fn html_error_page_is_an_error() {
        let err = parse_response(RUNTIME_ERROR, 0.0, 0.0, 200).unwrap_err();
        assert!(err.to_string().contains("bad Overpass response"), "{err}");
    }

    #[test]
    fn json_remark_error_is_an_error() {
        let body = r#"{"elements": [], "remark": "runtime error: Query timed out"}"#;
        assert!(parse_response(body, 0.0, 0.0, 200).is_err());
        let ok = r#"{"elements": [], "remark": "note: nothing wrong"}"#;
        assert!(parse_response(ok, 0.0, 0.0, 200).unwrap().is_empty());
    }
}
