//! The pick workflow (SPEC.md §6). Each step takes the session and returns it
//! updated; Step Functions calls them one by one, the CLI via [`run_pick`].

use std::collections::HashSet;
use std::future::Future;

use chrono::{DateTime, Duration, Utc};
use domain::assign::assign;
use domain::classify::{Classifier, CountryDishes, PlaceInput};
use domain::countries::{CountriesFile, Country};
use domain::guessing::{GuessConfig, MAX_PLACES, guess_untagged};
use domain::matching::{Match, MatchKind, primary_matches};
use domain::pick::choose_restaurant;
use domain::places::{Place, Places};
use domain::pool::pool;
use domain::race::{RaceProvider, RaceStatus, candidates};
use domain::session::{PickError, PickSession, PickStatus};
use domain::status::Restaurant;
use domain::store::{GuessCache, PickStore, StoreError, VisitStore, record_pick};
use domain::winner::{Decision, resolve};
use rand::Rng;

/// Poll interval for results (F5.1).
pub const POLL_INTERVAL: Duration = Duration::seconds(60);

#[derive(Debug, Clone)]
pub struct Config {
    /// OSM amenities that count as restaurants (F6.1).
    pub amenities: Vec<String>,
    /// Minimum confidence for inferred matches (F6.3).
    pub confidence_threshold: f64,
    pub guess: GuessConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            amenities: domain::places::DEFAULT_AMENITIES
                .iter()
                .map(|s| s.to_string())
                .collect(),
            confidence_threshold: domain::matching::DEFAULT_CONFIDENCE_THRESHOLD,
            guess: GuessConfig {
                prompt_version: 1,
                model_id: "unset".into(),
            },
        }
    }
}

/// Everything the steps need.
pub struct Deps<R, P, C, S> {
    pub races: R,
    pub places: P,
    pub classifier: C,
    pub store: S,
    pub countries: CountriesFile,
    pub config: Config,
}

impl<R, P, C, S> Deps<R, P, C, S> {
    fn country(&self, iso2: &str) -> Option<&Country> {
        self.countries.get(iso2)
    }
}

/// Step 1: choose the race (F3). Fails the pick if there is none or TAB is down.
pub async fn find_race<R, P, C, S>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    now: DateTime<Utc>,
) -> PickSession
where
    R: RaceProvider + Sync,
{
    let schedule = match deps.races.schedule(now).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "race schedule unavailable");
            session.fail(PickError::RaceSourceUnavailable);
            return session;
        }
    };
    for race in candidates(&schedule, now) {
        match deps.races.update(race).await {
            Ok(u) if u.race.status == RaceStatus::Open && u.race.has_enough_runners() => {
                session.race = Some(u.race);
                return session;
            }
            Ok(_) => continue,
            Err(e) => tracing::warn!(race = %race.id, error = %e, "race card unavailable"),
        }
    }
    session.fail(PickError::NoUpcomingRace);
    session
}

/// Step 2: build the pool and draw countries (F2, F4). Sets `waiting_start`.
pub async fn assign_countries<R, P, C, S, G>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    rng: &mut G,
) -> Result<PickSession, StoreError>
where
    S: VisitStore + Sync,
    G: Rng + Send,
{
    let Some(race) = session.race.as_ref() else {
        session.fail(PickError::Internal);
        return Ok(session);
    };
    let visited: HashSet<String> = deps
        .store
        .country_visits()
        .await?
        .into_iter()
        .filter(|c| c.visit_count > 0)
        .map(|c| c.iso2)
        .collect();
    let p = pool(
        &deps.countries.countries,
        session.request.min_population,
        &visited,
        session.request.include_visited,
    );
    match assign(&race.runners, &p, rng) {
        Ok(card) => {
            session.world_complete = p.world_complete;
            session.card = Some(card);
            session.status = PickStatus::WaitingStart;
        }
        Err(_) => session.fail(PickError::Internal),
    }
    Ok(session)
}

/// Step 3: fetch nearby places and guess cuisines for untagged ones (F6.1, F6.3),
/// while the race hasn't started yet (F6.4).
pub async fn prepare_nearby<R, P, C, S>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    now: DateTime<Utc>,
) -> PickSession
where
    P: Places + Sync,
    C: Classifier + Sync,
    S: GuessCache + Sync,
{
    let amenities: Vec<&str> = deps.config.amenities.iter().map(String::as_str).collect();
    let loc = &session.location;
    match deps
        .places
        .nearby(loc.lat, loc.lon, session.request.radius_m, &amenities)
        .await
    {
        Ok(places) => session.places = places,
        Err(e) => {
            tracing::warn!(error = %e, "places unavailable");
            session.fail(PickError::PlacesUnavailable);
            return session;
        }
    }
    let out = guess_untagged(
        &session.places,
        &deps.classifier,
        &deps.store,
        &deps.config.guess,
        now,
    )
    .await;
    session.guesses = out.guesses;
    session.llm_unavailable |= out.llm_unavailable;
    session
}

/// Step 4: poll the race once (F5). Returns the session and whether a winner is
/// decided (status `resolving`).
pub async fn check_result<R, P, C, S, G>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    now: DateTime<Utc>,
    rng: &mut G,
) -> (PickSession, bool)
where
    R: RaceProvider + Sync,
    G: Rng + Send,
{
    let (Some(race), Some(card)) = (session.race.clone(), session.card.as_mut()) else {
        session.fail(PickError::Internal);
        return (session, false);
    };
    let snapshot = match deps.races.update(&race).await {
        Ok(u) => {
            card.apply_scratchings(&u.race.runners);
            let snap = u.snapshot();
            session.race = Some(u.race);
            Some(snap)
        }
        Err(e) => {
            tracing::warn!(error = %e, "result check failed; will retry");
            None
        }
    };
    if let Some(s) = &snapshot {
        if s.status == RaceStatus::Interim {
            if s.placings != session.interim_placings || session.interim_since.is_none() {
                session.interim_placings = s.placings.clone();
                session.interim_since = Some(now);
            }
        } else {
            session.interim_placings.clear();
            session.interim_since = None;
        }
    }
    if now >= race.start_time && session.status == PickStatus::WaitingStart {
        session.status = PickStatus::Running;
    }
    let card = session.card.as_ref().expect("checked above");
    match resolve(
        card,
        snapshot.as_ref(),
        race.start_time,
        now,
        session.interim_since,
        rng,
    ) {
        Decision::Winner(w) => {
            session.winner = Some(w);
            session.status = PickStatus::Resolving;
            (session, true)
        }
        Decision::Pending => (session, false),
    }
}

/// Step 5: tiers 1–2 (F6.2–F6.4). Sets `searching`.
pub fn match_restaurants<R, P, C, S>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
) -> PickSession {
    session.status = PickStatus::Searching;
    let Some(country) = session
        .winner
        .as_ref()
        .and_then(|w| deps.country(&w.country_iso))
    else {
        session.fail(PickError::Internal);
        return session;
    };
    session.matches = primary_matches(
        &session.places,
        &session.guesses,
        country,
        deps.config.confidence_threshold,
    );
    session
}

/// Step 6: tier 3, only when there are no primary matches (F6.5, F6.8).
pub async fn fallback_match<R, P, C, S>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
) -> PickSession
where
    C: Classifier + Sync,
{
    if !session.matches.is_empty() || session.places.is_empty() {
        return session;
    }
    let Some(country) = session
        .winner
        .as_ref()
        .and_then(|w| deps.country(&w.country_iso))
    else {
        session.fail(PickError::Internal);
        return session;
    };
    let inputs: Vec<PlaceInput> = session
        .places
        .iter()
        .take(MAX_PLACES)
        .map(PlaceInput::from)
        .collect();
    let dishes = CountryDishes {
        name: country.name.clone(),
        dishes: country.dishes.clone(),
    };
    match deps.classifier.match_dishes(&inputs, &dishes).await {
        Ok(found) => {
            session.matches = found
                .into_iter()
                .map(|m| Match {
                    place_id: m.place_id,
                    kind: MatchKind::Fallback,
                    reason: Some(m.reason),
                })
                .collect();
        }
        Err(e) => {
            tracing::warn!(error = %e, "dish matching failed");
            session.llm_unavailable = true;
        }
    }
    session
}

/// Build the stored restaurant for a matched place.
pub fn restaurant_from(place: &Place, country_iso: &str, m: &Match) -> Restaurant {
    Restaurant {
        id: place.id.clone(),
        name: place.name.clone(),
        lat: place.lat,
        lon: place.lon,
        address: place.address.clone(),
        cuisine: place.cuisine.clone(),
        country_iso: country_iso.to_string(),
        status: None,
        status_before_pick: None,
        picked_at: None,
        visited_at: None,
        visit_count: 0,
        pick_id: None,
        kind: Some(m.kind),
        reason: m.reason.clone(),
    }
}

/// Step 7: choose the restaurant and mark it `PICKED` (F7, F8). Sets `done`.
pub async fn pick_restaurant<R, P, C, S, G>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    now: DateTime<Utc>,
    rng: &mut G,
) -> Result<PickSession, StoreError>
where
    S: VisitStore + Sync,
    G: Rng + Send,
{
    let Some(winner) = session.winner.clone() else {
        session.fail(PickError::Internal);
        return Ok(session);
    };
    let mut visit_counts = std::collections::HashMap::new();
    for m in &session.matches {
        let n = deps
            .store
            .get_restaurant(&m.place_id)
            .await?
            .map_or(0, |r| r.visit_count);
        visit_counts.insert(m.place_id.clone(), n);
    }
    let (primary, fallback): (Vec<Match>, Vec<Match>) = session
        .matches
        .iter()
        .cloned()
        .partition(|m| m.kind != MatchKind::Fallback);
    let chosen = choose_restaurant(
        &primary,
        &fallback,
        |id| visit_counts.get(id).copied().unwrap_or(0),
        rng,
    )
    .cloned();
    if let Some(m) = chosen
        && let Some(place) = session.places.iter().find(|p| p.id == m.place_id)
    {
        let candidate = restaurant_from(place, &winner.country_iso, &m);
        record_pick(&deps.store, candidate, &session.pick_id, now).await?;
        session.pick = Some(m.place_id);
    }
    session.status = PickStatus::Done;
    Ok(session)
}

/// Time source for [`run_pick`]; tests use a fake that jumps instead of sleeping.
pub trait Clock {
    fn now(&self) -> DateTime<Utc>;
    fn sleep_until(&self, t: DateTime<Utc>) -> impl Future<Output = ()> + Send;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    async fn sleep_until(&self, t: DateTime<Utc>) {
        if let Ok(d) = (t - Utc::now()).to_std() {
            tokio::time::sleep(d).await;
        }
    }
}

/// Run a whole pick in-process (the CLI and tests), saving the session after
/// every step. `on_update` sees each saved session.
pub async fn run_pick<R, P, C, S, K, G>(
    deps: &Deps<R, P, C, S>,
    mut session: PickSession,
    clock: &K,
    rng: &mut G,
    mut on_update: impl FnMut(&PickSession) + Send,
) -> Result<PickSession, StoreError>
where
    R: RaceProvider + Sync,
    P: Places + Sync,
    C: Classifier + Sync,
    S: VisitStore + PickStore + GuessCache + Sync,
    K: Clock + Sync,
    G: Rng + Send,
{
    macro_rules! save {
        () => {{
            deps.store.put_pick(&session).await?;
            on_update(&session);
            if session.status == PickStatus::Failed {
                return Ok(session);
            }
        }};
    }
    save!();
    session = find_race(deps, session, clock.now()).await;
    save!();
    session = assign_countries(deps, session, rng).await?;
    save!();
    session = prepare_nearby(deps, session, clock.now()).await;
    save!();
    let start = session.race.as_ref().map(|r| r.start_time);
    if let Some(start) = start {
        clock.sleep_until(start).await;
    }
    loop {
        let (s, decided) = check_result(deps, session, clock.now(), rng).await;
        session = s;
        save!();
        if decided {
            break;
        }
        clock.sleep_until(clock.now() + POLL_INTERVAL).await;
    }
    session = match_restaurants(deps, session);
    session = fallback_match(deps, session).await;
    save!();
    session = pick_restaurant(deps, session, clock.now(), rng).await?;
    save!();
    Ok(session)
}
