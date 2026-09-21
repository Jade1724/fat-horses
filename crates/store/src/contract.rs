//! The shared contract every store implementation must pass (SPEC.md §4.2).
//!
//! Call [`run_all`] from each implementation's tests with a factory for a fresh,
//! empty store. Failures panic with the scenario name.

use chrono::{DateTime, Duration, Utc};
use domain::classify::{CuisineGuess, Guess};
use domain::geo::Location;
use domain::matching::MatchKind;
use domain::session::{PickRequest, PickSession, PickStatus};
use domain::status::{self, Event, LogReason, Restaurant, Status};
use domain::store::{
    CachedGuess, CachedLocation, Change, GeocodeCache, GuessCache, PickStore, StoreError,
    VisitStore, record_pick, record_skip, record_visit,
};

/// Everything a full store provides.
pub trait Stores: VisitStore + PickStore + GuessCache + GeocodeCache + Sync {}
impl<T: VisitStore + PickStore + GuessCache + GeocodeCache + Sync> Stores for T {}

fn t0() -> DateTime<Utc> {
    "2026-09-21T10:00:00Z".parse().unwrap()
}

fn at(minutes: i64) -> DateTime<Utc> {
    t0() + Duration::minutes(minutes)
}

pub fn restaurant(id: &str, country_iso: &str) -> Restaurant {
    Restaurant {
        id: id.into(),
        name: format!("Restaurant {id}"),
        lat: -36.85,
        lon: 174.76,
        address: Some("1 Queen Street".into()),
        cuisine: vec!["japanese".into()],
        country_iso: country_iso.into(),
        status: None,
        status_before_pick: None,
        picked_at: None,
        visited_at: None,
        visit_count: 0,
        pick_id: None,
        kind: Some(MatchKind::Tagged),
        reason: None,
    }
}

/// Run every scenario, each on a fresh store from `make`.
pub async fn run_all<S: Stores>(make: impl Fn() -> S) {
    empty_store(&make()).await;
    pick_stores_restaurant(&make()).await;
    new_pick_supersedes_old(&make()).await;
    same_restaurant_picked_twice(&make()).await;
    visit_after_pick(&make()).await;
    visit_from_map(&make()).await;
    skip_restores(&make()).await;
    invalid_transitions(&make()).await;
    stale_writes_conflict(&make()).await;
    history_pages(&make()).await;
    pick_sessions(&make()).await;
    guess_cache(&make()).await;
    geocode_cache(&make()).await;
}

async fn empty_store<S: Stores>(s: &S) {
    assert!(s.get_restaurant("osm:node/1").await.unwrap().is_none());
    assert!(s.currently_picked().await.unwrap().is_none());
    assert!(s.country_visits().await.unwrap().is_empty());
    let h = s.history(None, 10).await.unwrap();
    assert!(h.entries.is_empty() && h.next_cursor.is_none());
}

async fn pick_stores_restaurant<S: Stores>(s: &S) {
    let r = record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    assert_eq!(r.status, Some(Status::Picked));
    let stored = s.get_restaurant("osm:node/1").await.unwrap().unwrap();
    assert_eq!(stored, r);
    assert_eq!(
        s.currently_picked().await.unwrap().unwrap().id,
        "osm:node/1"
    );
    let h = s.history(None, 10).await.unwrap();
    assert_eq!(h.entries.len(), 1);
    assert_eq!(h.entries[0].reason, LogReason::Picked);
    assert_eq!(h.entries[0].pick_id.as_deref(), Some("p1"));
}

async fn new_pick_supersedes_old<S: Stores>(s: &S) {
    record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    record_pick(s, restaurant("osm:node/2", "IT"), "p2", at(1))
        .await
        .unwrap();
    let first = s.get_restaurant("osm:node/1").await.unwrap().unwrap();
    assert_eq!(first.status, None, "superseded restaurant reverts");
    assert_eq!(
        s.currently_picked().await.unwrap().unwrap().id,
        "osm:node/2"
    );
    let reasons: Vec<LogReason> = s
        .history(None, 10)
        .await
        .unwrap()
        .entries
        .iter()
        .map(|e| e.reason)
        .collect();
    assert_eq!(
        reasons,
        [LogReason::Picked, LogReason::Superseded, LogReason::Picked],
        "newest first"
    );
}

async fn same_restaurant_picked_twice<S: Stores>(s: &S) {
    record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    let again = record_pick(s, restaurant("osm:node/1", "JP"), "p2", at(1))
        .await
        .unwrap();
    assert_eq!(again.status, Some(Status::Picked));
    assert_eq!(again.pick_id.as_deref(), Some("p2"));
    assert_eq!(
        s.currently_picked().await.unwrap().unwrap().id,
        "osm:node/1"
    );
}

async fn visit_after_pick<S: Stores>(s: &S) {
    record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    let r = record_visit(s, "osm:node/1", None, at(30)).await.unwrap();
    assert_eq!(r.status, Some(Status::Visited));
    assert_eq!(r.visit_count, 1);
    assert!(s.currently_picked().await.unwrap().is_none());
    let countries = s.country_visits().await.unwrap();
    assert_eq!(countries.len(), 1);
    assert_eq!(countries[0].iso2, "JP");
    assert_eq!(countries[0].visit_count, 1);
    assert_eq!(countries[0].first_visited_at, Some(at(30)));

    // Picked again later and visited again: counts go up, first visit stays.
    record_pick(s, restaurant("osm:node/1", "JP"), "p2", at(60))
        .await
        .unwrap();
    let picked = s.get_restaurant("osm:node/1").await.unwrap().unwrap();
    assert_eq!(picked.status_before_pick, Some(Status::Visited));
    let r = record_visit(s, "osm:node/1", None, at(90)).await.unwrap();
    assert_eq!(r.visit_count, 2);
    let c = &s.country_visits().await.unwrap()[0];
    assert_eq!(c.visit_count, 2);
    assert_eq!(c.first_visited_at, Some(at(30)));
    assert_eq!(c.last_visited_at, Some(at(90)));
}

async fn visit_from_map<S: Stores>(s: &S) {
    assert!(matches!(
        record_visit(s, "osm:node/7", None, at(0)).await,
        Err(StoreError::NotFound)
    ));
    let r = record_visit(s, "osm:node/7", Some(restaurant("osm:node/7", "MX")), at(0))
        .await
        .unwrap();
    assert_eq!(r.status, Some(Status::Visited));
    assert_eq!(s.country_visits().await.unwrap()[0].iso2, "MX");
    // A map visit leaves another restaurant's PICKED status alone.
    record_pick(s, restaurant("osm:node/8", "JP"), "p1", at(1))
        .await
        .unwrap();
    record_visit(s, "osm:node/7", None, at(2)).await.unwrap();
    assert_eq!(
        s.currently_picked().await.unwrap().unwrap().id,
        "osm:node/8"
    );
}

async fn skip_restores<S: Stores>(s: &S) {
    record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    let r = record_skip(s, "osm:node/1", at(1)).await.unwrap();
    assert_eq!(r.status, None);
    assert!(s.currently_picked().await.unwrap().is_none());
    assert!(s.country_visits().await.unwrap().is_empty());
}

async fn invalid_transitions<S: Stores>(s: &S) {
    assert!(matches!(
        record_skip(s, "osm:node/1", at(0)).await,
        Err(StoreError::NotFound)
    ));
    record_visit(s, "osm:node/1", Some(restaurant("osm:node/1", "JP")), at(0))
        .await
        .unwrap();
    assert!(matches!(
        record_skip(s, "osm:node/1", at(1)).await,
        Err(StoreError::InvalidTransition(_))
    ));
}

async fn stale_writes_conflict<S: Stores>(s: &S) {
    record_pick(s, restaurant("osm:node/1", "JP"), "p1", at(0))
        .await
        .unwrap();
    // A transition computed from a stale read (status null) must not overwrite.
    let stale = status::apply(&restaurant("osm:node/1", "JP"), Event::Visit, at(1)).unwrap();
    let err = s
        .apply(Change {
            transitions: vec![stale],
            expected_picked: Some("osm:node/1".into()),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::Conflict), "{err:?}");

    // A wrong PICKED pointer must not overwrite either, and nothing is written.
    let fresh = status::apply(&restaurant("osm:node/2", "IT"), Event::Visit, at(2)).unwrap();
    let err = s
        .apply(Change {
            transitions: vec![fresh],
            expected_picked: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::Conflict), "{err:?}");
    assert!(s.get_restaurant("osm:node/2").await.unwrap().is_none());
    assert_eq!(s.history(None, 10).await.unwrap().entries.len(), 1);
    assert!(s.country_visits().await.unwrap().is_empty());
}

async fn history_pages<S: Stores>(s: &S) {
    for i in 0..5 {
        let id = format!("osm:node/{i}");
        record_visit(s, &id, Some(restaurant(&id, "JP")), at(i))
            .await
            .unwrap();
    }
    let p1 = s.history(None, 2).await.unwrap();
    let ids = |p: &domain::store::HistoryPage| -> Vec<String> {
        p.entries.iter().map(|e| e.restaurant_id.clone()).collect()
    };
    assert_eq!(ids(&p1), ["osm:node/4", "osm:node/3"]);
    let p2 = s.history(p1.next_cursor.clone(), 2).await.unwrap();
    assert_eq!(ids(&p2), ["osm:node/2", "osm:node/1"]);
    let p3 = s.history(p2.next_cursor.clone(), 2).await.unwrap();
    assert_eq!(ids(&p3), ["osm:node/0"]);
    assert!(p3.next_cursor.is_none());
}

async fn pick_sessions<S: Stores>(s: &S) {
    assert!(s.get_pick("p1").await.unwrap().is_none());
    let mut session = PickSession::new(
        "p1".into(),
        t0(),
        PickRequest {
            radius_m: 200,
            min_population: 10_000_000,
            include_visited: false,
        },
        Location {
            lat: -36.85,
            lon: 174.76,
            display_name: "Sky Tower".into(),
        },
    );
    s.put_pick(&session).await.unwrap();
    assert_eq!(s.get_pick("p1").await.unwrap().unwrap(), session);
    session.status = PickStatus::Done;
    session.pick = Some("osm:node/1".into());
    s.put_pick(&session).await.unwrap();
    assert_eq!(s.get_pick("p1").await.unwrap().unwrap(), session);
}

async fn guess_cache<S: Stores>(s: &S) {
    let g = |version: u32, tag: &str| CachedGuess {
        guess: Guess {
            place_id: "osm:node/1".into(),
            cuisines: vec![CuisineGuess {
                tag: tag.into(),
                confidence: 0.9,
            }],
            reason: "name".into(),
        },
        prompt_version: version,
        input_hash: "abc".into(),
        model_id: "model".into(),
        created_at: t0(),
    };
    assert!(s.get_guess("osm:node/1", 1).await.unwrap().is_none());
    s.put_guess(&g(1, "japanese")).await.unwrap();
    s.put_guess(&g(2, "sushi")).await.unwrap();
    assert_eq!(
        s.get_guess("osm:node/1", 1).await.unwrap().unwrap(),
        g(1, "japanese")
    );
    assert_eq!(
        s.get_guess("osm:node/1", 2).await.unwrap().unwrap(),
        g(2, "sushi")
    );
    assert!(s.get_guess("osm:node/2", 1).await.unwrap().is_none());
}

async fn geocode_cache<S: Stores>(s: &S) {
    let v = CachedLocation {
        location: Location {
            lat: 1.0,
            lon: 2.0,
            display_name: "x".into(),
        },
        created_at: t0(),
    };
    assert!(s.get_geocode("1 queen street").await.unwrap().is_none());
    s.put_geocode("1 queen street", &v).await.unwrap();
    assert_eq!(s.get_geocode("1 queen street").await.unwrap().unwrap(), v);
}
