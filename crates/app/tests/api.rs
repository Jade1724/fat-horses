//! HTTP API handlers (TASKS.md T4.4, SPEC.md §5).

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use domain::countries::CountriesFile;
use domain::geo::{GeocodeError, Geocoder, Location};
use domain::session::PickStatus;
use domain::store::{PickStore, record_pick};
use fat_horses_app::api::{Api, Method, Request, Response, WorkflowStarter, constant_time_eq};
use fat_horses_store::{MemoryStore, contract};
use serde_json::{Value, json};

const KEY: &str = "s3cret-key";

fn now() -> DateTime<Utc> {
    "2026-09-21T10:00:00Z".parse().unwrap()
}

struct FakeGeocoder;

impl Geocoder for FakeGeocoder {
    async fn geocode(&self, address: &str) -> Result<Option<Location>, GeocodeError> {
        Ok((!address.contains("nowhere")).then(|| Location {
            lat: -36.8485,
            lon: 174.7622,
            display_name: "Sky Tower, Auckland".into(),
        }))
    }
}

#[derive(Default)]
struct FakeStarter {
    started: Mutex<Vec<String>>,
    fail: bool,
}

impl WorkflowStarter for FakeStarter {
    async fn start(&self, pick_id: &str) -> Result<(), String> {
        if self.fail {
            return Err("step functions down".into());
        }
        self.started.lock().unwrap().push(pick_id.to_string());
        Ok(())
    }
}

fn api() -> Api<FakeGeocoder, MemoryStore, FakeStarter> {
    api_with(FakeStarter::default())
}

fn api_with(starter: FakeStarter) -> Api<FakeGeocoder, MemoryStore, FakeStarter> {
    Api {
        geocoder: FakeGeocoder,
        store: MemoryStore::new(),
        starter,
        countries: CountriesFile::bundled(),
        api_key: KEY.into(),
    }
}

fn req(method: Method, path: &str, body: Option<Value>) -> Request {
    Request {
        method,
        path: path.into(),
        query: HashMap::new(),
        api_key: Some(KEY.into()),
        body: body.map(|b| b.to_string()),
    }
}

fn get(path: &str) -> Request {
    req(Method::Get, path, None)
}

fn post(path: &str, body: Value) -> Request {
    req(Method::Post, path, Some(body))
}

fn assert_error(r: &Response, status: u16, code: &str) {
    assert_eq!(r.status, status, "{:?}", r.body);
    assert_eq!(r.body["error"], code, "{:?}", r.body);
}

#[tokio::test]
async fn api_key_is_required() {
    let a = api();
    let mut r = get("/history");
    r.api_key = None;
    assert_error(&a.handle(r, now()).await, 401, "unauthorized");
    let mut r = get("/history");
    r.api_key = Some("wrong".into());
    assert_error(&a.handle(r, now()).await, 401, "unauthorized");
    assert_eq!(a.handle(get("/history"), now()).await.status, 200);
}

#[test]
fn constant_time_comparison() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"abcd"));
}

#[tokio::test]
async fn unknown_routes_are_404() {
    let a = api();
    for r in [
        get("/nope"),
        get("/picks/"),
        post("/restaurants/osm:node/1/eat", json!({})),
        req(Method::Other, "/picks", None),
    ] {
        assert_error(&a.handle(r, now()).await, 404, "not_found");
    }
}

#[tokio::test]
async fn start_pick_stores_and_starts() {
    let a = api();
    let r = a
        .handle(post("/picks", json!({ "address": "Sky Tower" })), now())
        .await;
    assert_eq!(r.status, 202, "{:?}", r.body);
    let id = r.body["pick_id"].as_str().unwrap().to_string();
    assert_eq!(*a.starter.started.lock().unwrap(), vec![id.clone()]);
    let s = a.store.get_pick(&id).await.unwrap().unwrap();
    assert_eq!(s.status, PickStatus::FindingRace);
    assert_eq!(s.request.radius_m, 200);

    let view = a.handle(get(&format!("/picks/{id}")), now()).await;
    assert_eq!(view.status, 200);
    assert_eq!(view.body["status"], "finding_race");
    assert_eq!(view.body["location"]["radius_m"], 200);
    assert_eq!(view.body["location"]["display_name"], "Sky Tower, Auckland");
    assert_eq!(view.body["restaurants"], json!([]));
    assert_eq!(view.body["race"], Value::Null);
}

#[tokio::test]
async fn start_pick_errors() {
    let a = api();
    let bad = a
        .handle(
            post("/picks", json!({ "address": "x", "radius_m": 5 })),
            now(),
        )
        .await;
    assert_error(&bad, 422, "invalid_request");
    let bad = a.handle(post("/picks", json!({})), now()).await;
    assert_error(&bad, 422, "invalid_request");
    let mut garbled = post("/picks", json!({}));
    garbled.body = Some("{not json".into());
    assert_error(&a.handle(garbled, now()).await, 422, "invalid_request");
    let missing = a
        .handle(post("/picks", json!({ "address": "nowhere" })), now())
        .await;
    assert_error(&missing, 422, "address_not_found");
    assert!(a.starter.started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn start_failure_is_503() {
    let a = api_with(FakeStarter {
        fail: true,
        ..Default::default()
    });
    let r = a
        .handle(post("/picks", json!({ "lat": -36.8, "lon": 174.7 })), now())
        .await;
    assert_error(&r, 503, "internal");
}

#[tokio::test]
async fn unknown_pick_is_404() {
    assert_error(
        &api().handle(get("/picks/nope"), now()).await,
        404,
        "not_found",
    );
}

#[tokio::test]
async fn picked_visit_and_skip() {
    let a = api();
    let picked = a.handle(get("/restaurants/picked"), now()).await;
    assert_eq!(picked.status, 200);
    assert_eq!(picked.body, Value::Null);

    record_pick(
        &a.store,
        contract::restaurant("osm:node/1", "JP"),
        "p1",
        now(),
    )
    .await
    .unwrap();
    let picked = a.handle(get("/restaurants/picked"), now()).await;
    assert_eq!(picked.body["id"], "osm:node/1");
    assert_eq!(picked.body["status"], "PICKED");

    // Percent-encoded id, as the web client sends it.
    let r = a
        .handle(post("/restaurants/osm%3Anode%2F1/visit", json!({})), now())
        .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["status"], "VISITED");
    assert_eq!(r.body["visit_count"], 1);

    // Skipping a visited restaurant is not a valid transition.
    let r = a
        .handle(post("/restaurants/osm:node/1/skip", json!({})), now())
        .await;
    assert_error(&r, 409, "invalid_transition");
}

#[tokio::test]
async fn skip_picked() {
    let a = api();
    record_pick(
        &a.store,
        contract::restaurant("osm:way/7", "IT"),
        "p1",
        now(),
    )
    .await
    .unwrap();
    let r = a
        .handle(post("/restaurants/osm:way/7/skip", json!({})), now())
        .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["status"], Value::Null);
    let r = a
        .handle(post("/restaurants/osm:way/8/skip", json!({})), now())
        .await;
    assert_error(&r, 404, "not_found");
}

#[tokio::test]
async fn visit_from_the_map_needs_details() {
    let a = api();
    let r = a
        .handle(post("/restaurants/osm:node/5/visit", json!({})), now())
        .await;
    assert_error(&r, 422, "invalid_request");
    let r = a
        .handle(
            post(
                "/restaurants/osm:node/5/visit",
                json!({ "restaurant": { "name": "Le Chalet", "lat": -36.8, "lon": 174.7,
                                        "country_iso": "XX" } }),
            ),
            now(),
        )
        .await;
    assert_error(&r, 422, "invalid_request");
    let r = a
        .handle(
            post(
                "/restaurants/osm:node/5/visit",
                json!({ "restaurant": { "name": "Taqueria", "lat": -36.8, "lon": 174.7,
                                        "cuisine": ["mexican"], "country_iso": "MX" } }),
            ),
            now(),
        )
        .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["country_iso"], "MX");
}

#[tokio::test]
async fn countries_and_history() {
    let a = api();
    record_pick(
        &a.store,
        contract::restaurant("osm:node/1", "JP"),
        "p1",
        now(),
    )
    .await
    .unwrap();
    a.handle(post("/restaurants/osm:node/1/visit", json!({})), now())
        .await;

    let c = a.handle(get("/countries"), now()).await;
    assert_eq!(c.status, 200);
    assert_eq!(c.body["total"], 95);
    assert_eq!(c.body["visited"], 1);
    let jp = c.body["countries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["iso2"] == "JP")
        .unwrap();
    assert_eq!(jp["visited"], true);
    assert_eq!(jp["visit_count"], 1);

    let mut small = get("/countries");
    small
        .query
        .insert("min_population".into(), "100000000".into());
    let c = a.handle(small, now()).await;
    assert!(c.body["total"].as_u64().unwrap() < 20);

    let mut bad = get("/countries");
    bad.query.insert("min_population".into(), "lots".into());
    assert_error(&a.handle(bad, now()).await, 422, "invalid_request");

    let h = a.handle(get("/history"), now()).await;
    assert_eq!(h.status, 200);
    let entries = h.body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["reason"], "visited");
    assert_eq!(entries[1]["reason"], "picked");
}
