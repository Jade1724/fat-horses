//! Whole-pick scenarios with fakes (TASKS.md T4.1).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use domain::classify::{CuisineGuess, FakeClassifier, Guess};
use domain::countries::{CountriesFile, Country, Source};
use domain::geo::Location;
use domain::matching::MatchKind;
use domain::places::{Place, Places, PlacesError, parse_cuisine};
use domain::race::{Race, RaceError, RaceProvider, RaceStatus, RaceType, RaceUpdate, Runner};
use domain::session::{PickError, PickRequest, PickSession, PickStatus};
use domain::status::Status;
use domain::store::{PickStore, VisitStore};
use domain::winner::{Placing, WinReason};
use fat_horses_app::workflow::{Clock, Config, Deps, run_pick};
use fat_horses_store::MemoryStore;
use rand::SeedableRng;
use rand::rngs::StdRng;

fn t0() -> DateTime<Utc> {
    "2026-09-21T10:00:00Z".parse().unwrap()
}

struct FakeClock(Mutex<DateTime<Utc>>);

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }

    async fn sleep_until(&self, t: DateTime<Utc>) {
        let mut now = self.0.lock().unwrap();
        if t > *now {
            *now = t;
        }
    }
}

/// Serves a fixed schedule, then the given updates in order (the last repeats).
struct FakeRaces {
    schedule: Vec<Race>,
    updates: Mutex<VecDeque<RaceUpdate>>,
}

impl RaceProvider for FakeRaces {
    async fn schedule(&self, _now: DateTime<Utc>) -> Result<Vec<Race>, RaceError> {
        Ok(self.schedule.clone())
    }

    async fn update(&self, _race: &Race) -> Result<RaceUpdate, RaceError> {
        let mut q = self.updates.lock().unwrap();
        let next = if q.len() > 1 {
            q.pop_front()
        } else {
            q.front().cloned()
        };
        next.ok_or_else(|| RaceError::Unavailable("no updates".into()))
    }
}

/// Returns its places, after failing the first `failures` calls.
struct FakePlaces {
    places: Vec<Place>,
    failures: Mutex<usize>,
}

impl FakePlaces {
    fn new(places: Vec<Place>) -> Self {
        Self::failing(places, 0)
    }

    fn failing(places: Vec<Place>, failures: usize) -> Self {
        Self {
            places,
            failures: Mutex::new(failures),
        }
    }
}

impl Places for FakePlaces {
    async fn nearby(
        &self,
        _lat: f64,
        _lon: f64,
        _radius_m: u32,
        _amenities: &[&str],
    ) -> Result<Vec<Place>, PlacesError> {
        let mut left = self.failures.lock().unwrap();
        if *left > 0 {
            *left -= 1;
            return Err(PlacesError::Unavailable("504".into()));
        }
        Ok(self.places.clone())
    }
}

fn country(iso2: &str, name: &str, tags: &[&str], dishes: &[&str]) -> Country {
    Country {
        iso2: iso2.into(),
        name: name.into(),
        flag: "🏳".into(),
        population: 50_000_000,
        cuisine_tags: tags.iter().map(|s| s.to_string()).collect(),
        dishes: dishes.iter().map(|s| s.to_string()).collect(),
    }
}

fn countries() -> CountriesFile {
    CountriesFile {
        source: Source {
            population: "test".into(),
            year: 2025,
        },
        countries: vec![
            country(
                "JP",
                "Japan",
                &["japanese", "sushi"],
                &["sushi", "ramen", "miso"],
            ),
            country(
                "IT",
                "Italy",
                &["italian", "pizza"],
                &["pizza", "pasta", "gelato"],
            ),
            country("MX", "Mexico", &["mexican"], &["tacos", "mole", "tamales"]),
        ],
    }
}

fn place(id: &str, name: &str, cuisine: &str) -> Place {
    Place {
        id: id.into(),
        name: name.into(),
        lat: -36.85,
        lon: 174.76,
        address: None,
        amenity: "restaurant".into(),
        cuisine: parse_cuisine(cuisine),
        tags: BTreeMap::new(),
        distance_m: 50.0,
    }
}

/// One tagged restaurant per country, so whichever country wins has a match.
fn one_per_country() -> Vec<Place> {
    vec![
        place("osm:node/1", "Sakura", "sushi"),
        place("osm:node/2", "Roma", "pizza"),
        place("osm:node/3", "Taqueria", "mexican"),
    ]
}

fn race(status: RaceStatus) -> Race {
    Race {
        id: "r1".into(),
        meeting_id: "m1".into(),
        venue: "Ellerslie".into(),
        venue_country: "NZ".into(),
        race_number: 3,
        name: "Test Stakes".into(),
        race_type: RaceType::Gallops,
        status,
        start_time: t0() + Duration::minutes(8),
        runners: (1..=3)
            .map(|n| Runner {
                number: n,
                name: format!("Horse {n}"),
                scratched: false,
            })
            .collect(),
    }
}

fn update(status: RaceStatus, placings: &[(u32, u32)]) -> RaceUpdate {
    RaceUpdate {
        race: race(status),
        placings: placings
            .iter()
            .map(|&(position, number)| Placing { position, number })
            .collect(),
    }
}

fn session() -> PickSession {
    PickSession::new(
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
    )
}

struct Run {
    session: PickSession,
    store: MemoryStore,
    statuses: Vec<PickStatus>,
}

async fn run(
    schedule: Vec<Race>,
    updates: Vec<RaceUpdate>,
    places: Vec<Place>,
    classifier: FakeClassifier,
) -> Run {
    run_with_store(MemoryStore::new(), schedule, updates, places, classifier).await
}

async fn run_with_store(
    store: MemoryStore,
    schedule: Vec<Race>,
    updates: Vec<RaceUpdate>,
    places: Vec<Place>,
    classifier: FakeClassifier,
) -> Run {
    run_full(
        store,
        schedule,
        updates,
        FakePlaces::new(places),
        classifier,
    )
    .await
}

async fn run_full(
    store: MemoryStore,
    schedule: Vec<Race>,
    updates: Vec<RaceUpdate>,
    places: FakePlaces,
    classifier: FakeClassifier,
) -> Run {
    let deps = Deps {
        races: FakeRaces {
            schedule,
            updates: Mutex::new(updates.into()),
        },
        places,
        classifier,
        store,
        countries: countries(),
        config: Config::default(),
    };
    let clock = FakeClock(Mutex::new(t0()));
    let mut statuses = Vec::new();
    let session = run_pick(
        &deps,
        session(),
        &clock,
        &mut StdRng::seed_from_u64(7),
        |s| statuses.push(s.status),
    )
    .await
    .unwrap();
    Run {
        session,
        store: deps.store,
        statuses,
    }
}

fn open_then(result: RaceUpdate) -> Vec<RaceUpdate> {
    vec![
        update(RaceStatus::Open, &[]), // find_race
        update(RaceStatus::Closed, &[]),
        result,
    ]
}

#[tokio::test]
async fn normal_pick() {
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 2), (2, 1), (3, 3)])),
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    let s = &r.session;
    assert_eq!(s.status, PickStatus::Done);
    let winner = s.winner.as_ref().unwrap();
    assert_eq!(winner.number, 2);
    assert_eq!(winner.reason, WinReason::Result);
    let card = s.card.as_ref().unwrap();
    assert_eq!(
        card.entry(2).unwrap().country_iso.as_deref(),
        Some(winner.country_iso.as_str())
    );

    // The pick is the one tagged restaurant for the winning country.
    assert_eq!(s.matches.len(), 1);
    assert_eq!(s.matches[0].kind, MatchKind::Tagged);
    let picked = r.store.currently_picked().await.unwrap().unwrap();
    assert_eq!(Some(picked.id.clone()), s.pick);
    assert_eq!(picked.status, Some(Status::Picked));
    assert_eq!(picked.country_iso, winner.country_iso);

    assert_eq!(r.store.get_pick("p1").await.unwrap().unwrap(), r.session);
    assert_eq!(r.statuses.first(), Some(&PickStatus::FindingRace));
    assert!(r.statuses.contains(&PickStatus::WaitingStart));
    assert!(r.statuses.contains(&PickStatus::Running));
    assert_eq!(r.statuses.last(), Some(&PickStatus::Done));
}

#[tokio::test]
async fn dead_heat() {
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1), (1, 3), (3, 2)])),
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    let w = r.session.winner.unwrap();
    assert_eq!(w.reason, WinReason::DeadHeat);
    assert_eq!(w.tied, [1, 3]);
    assert!([1, 3].contains(&w.number));
    assert!(r.session.pick.is_some());
}

#[tokio::test]
async fn abandoned_race_picks_a_random_assigned_country() {
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Abandoned, &[])),
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    let w = r.session.winner.unwrap();
    assert_eq!(w.reason, WinReason::Abandoned);
    assert_eq!(r.session.status, PickStatus::Done);
    assert!(r.session.pick.is_some());
}

#[tokio::test]
async fn no_result_times_out() {
    let r = run(
        vec![race(RaceStatus::Open)],
        vec![
            update(RaceStatus::Open, &[]),
            update(RaceStatus::Closed, &[]),
        ],
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    assert_eq!(r.session.winner.unwrap().reason, WinReason::Timeout);
}

#[tokio::test]
async fn no_match_is_done_without_a_pick() {
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        vec![place("osm:node/9", "Burger Barn", "burger")],
        FakeClassifier::new(),
    )
    .await;
    assert_eq!(r.session.status, PickStatus::Done);
    assert!(r.session.matches.is_empty());
    assert!(r.session.pick.is_none());
    assert!(r.store.currently_picked().await.unwrap().is_none());
    assert!(!r.session.llm_unavailable);
}

#[tokio::test]
async fn llm_failure_still_finishes() {
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        vec![place("osm:node/9", "Mystery Kitchen", "")],
        FakeClassifier::failing(),
    )
    .await;
    assert_eq!(r.session.status, PickStatus::Done);
    assert!(r.session.llm_unavailable);
    assert!(r.session.pick.is_none());
}

#[tokio::test]
async fn inferred_matches_count_as_primary() {
    let untagged = vec![
        place("osm:node/1", "Sakura", ""),
        place("osm:node/2", "Roma", ""),
        place("osm:node/3", "Taqueria", ""),
    ];
    let guess = |id: &str, tag: &str| Guess {
        place_id: id.into(),
        cuisines: vec![CuisineGuess {
            tag: tag.into(),
            confidence: 0.9,
        }],
        reason: format!("{tag} name"),
    };
    let fake = FakeClassifier::new()
        .with_guess(guess("osm:node/1", "japanese"))
        .with_guess(guess("osm:node/2", "italian"))
        .with_guess(guess("osm:node/3", "mexican"));
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        untagged,
        fake,
    )
    .await;
    assert_eq!(r.session.guesses.len(), 3);
    assert_eq!(r.session.matches.len(), 1);
    assert_eq!(r.session.matches[0].kind, MatchKind::Inferred);
    assert!(r.session.pick.is_some());
}

#[tokio::test]
async fn fallback_when_no_primary_match() {
    let places = vec![place("osm:node/9", "Corner Bistro", "")];
    let mut fake = FakeClassifier::new();
    for name in ["Japan", "Italy", "Mexico"] {
        fake = fake.with_dish_match(name, "osm:node/9", "has the dishes");
    }
    let r = run(
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        places,
        fake,
    )
    .await;
    assert_eq!(r.session.matches.len(), 1);
    assert_eq!(r.session.matches[0].kind, MatchKind::Fallback);
    assert_eq!(r.session.pick.as_deref(), Some("osm:node/9"));
}

#[tokio::test]
async fn places_outage_before_the_race_is_retried() {
    let r = run_full(
        MemoryStore::new(),
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        FakePlaces::failing(one_per_country(), 1),
        FakeClassifier::new(),
    )
    .await;
    assert_eq!(r.session.status, PickStatus::Done);
    assert!(r.session.places_loaded);
    assert!(r.session.pick.is_some());
}

#[tokio::test]
async fn places_outage_after_the_race_fails() {
    let r = run_full(
        MemoryStore::new(),
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        FakePlaces::failing(one_per_country(), 2),
        FakeClassifier::new(),
    )
    .await;
    assert_eq!(r.session.status, PickStatus::Failed);
    assert_eq!(r.session.error, Some(PickError::PlacesUnavailable));
    assert!(
        r.session.winner.is_some(),
        "the winner is still shown (F5.5)"
    );
}

#[tokio::test]
async fn no_race_fails() {
    let r = run(vec![], vec![], one_per_country(), FakeClassifier::new()).await;
    assert_eq!(r.session.status, PickStatus::Failed);
    assert_eq!(r.session.error, Some(PickError::NoUpcomingRace));
    assert_eq!(
        r.store.get_pick("p1").await.unwrap().unwrap().status,
        PickStatus::Failed
    );
}

#[tokio::test]
async fn world_complete_when_every_country_is_visited() {
    let store = MemoryStore::new();
    for (id, iso) in [
        ("osm:node/1", "JP"),
        ("osm:node/2", "IT"),
        ("osm:node/3", "MX"),
    ] {
        domain::store::record_visit(
            &store,
            id,
            Some(fat_horses_store::contract::restaurant(id, iso)),
            t0(),
        )
        .await
        .unwrap();
    }
    let r = run_with_store(
        store,
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    assert!(r.session.world_complete);
    let assigned: std::collections::HashSet<String> = r
        .session
        .card
        .unwrap()
        .entries
        .into_iter()
        .filter_map(|e| e.country_iso)
        .collect();
    assert_eq!(assigned.len(), 3);
}

#[tokio::test]
async fn visited_countries_are_drawn_last() {
    // JP and IT visited: with 3 runners MX must be on the card, topped up by the
    // visited ones (F4.2), and the pool isn't complete.
    let store = MemoryStore::new();
    for (id, iso) in [("osm:node/1", "JP"), ("osm:node/2", "IT")] {
        domain::store::record_visit(
            &store,
            id,
            Some(fat_horses_store::contract::restaurant(id, iso)),
            t0(),
        )
        .await
        .unwrap();
    }
    let r = run_with_store(
        store,
        vec![race(RaceStatus::Open)],
        open_then(update(RaceStatus::Final, &[(1, 1)])),
        one_per_country(),
        FakeClassifier::new(),
    )
    .await;
    assert!(!r.session.world_complete);
    let card = r.session.card.unwrap();
    assert!(
        card.entries
            .iter()
            .any(|e| e.country_iso.as_deref() == Some("MX"))
    );
}
