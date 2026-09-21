//! Storage interfaces (SPEC.md §4.2) and the visit-tracking operations built on them (F8).

use std::future::Future;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::classify::Guess;
use crate::geo::Location;
use crate::session::PickSession;
use crate::status::{self, Event, InvalidTransition, LogEntry, Restaurant, Status, Transition};

/// How long a geocode result is reused (F1.3).
pub const GEOCODE_TTL: Duration = Duration::days(30);
/// How long a cuisine guess is reused (L6).
pub const GUESS_TTL: Duration = Duration::days(180);
/// How long a pick session is kept (§4.2).
pub const PICK_TTL: Duration = Duration::days(30);
/// History page size (F9.2).
pub const HISTORY_PAGE: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A condition failed: the data changed since it was read (F8.7).
    #[error("conflict: the data changed since it was read")]
    Conflict,
    #[error("not found")]
    NotFound,
    #[error(transparent)]
    InvalidTransition(#[from] InvalidTransition),
    #[error("store unavailable: {0}")]
    Unavailable(String),
}

/// Transitions written together, all or nothing (F8.7).
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub transitions: Vec<Transition>,
    /// The id the store must currently hold as the one `PICKED` restaurant (F8.3).
    pub expected_picked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountryVisits {
    pub iso2: String,
    pub visit_count: u32,
    pub first_visited_at: Option<DateTime<Utc>>,
    pub last_visited_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryPage {
    /// Newest first.
    pub entries: Vec<LogEntry>,
    pub next_cursor: Option<String>,
}

/// Restaurants, countries and the history log (F8, F9).
pub trait VisitStore {
    fn get_restaurant(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Option<Restaurant>, StoreError>> + Send;

    fn currently_picked(
        &self,
    ) -> impl Future<Output = Result<Option<Restaurant>, StoreError>> + Send;

    /// Write every transition in `change` atomically, or nothing. Fails with
    /// [`StoreError::Conflict`] if any restaurant's stored status differs from its
    /// `expected_status` (absent = `None`) or the `PICKED` pointer differs from
    /// `expected_picked`. Keeps the pointer to the one `PICKED` restaurant,
    /// updates country visit counts and appends the log entries.
    fn apply(&self, change: Change) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// Every country with at least one visit.
    fn country_visits(&self)
    -> impl Future<Output = Result<Vec<CountryVisits>, StoreError>> + Send;

    /// History, newest first. `cursor` is a previous page's `next_cursor`.
    fn history(
        &self,
        cursor: Option<String>,
        limit: usize,
    ) -> impl Future<Output = Result<HistoryPage, StoreError>> + Send;
}

pub trait PickStore {
    fn get_pick(
        &self,
        pick_id: &str,
    ) -> impl Future<Output = Result<Option<PickSession>, StoreError>> + Send;

    fn put_pick(
        &self,
        session: &PickSession,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedGuess {
    pub guess: Guess,
    pub prompt_version: u32,
    /// SHA-256 of the place's name and sorted tags (L6).
    pub input_hash: String,
    pub model_id: String,
    pub created_at: DateTime<Utc>,
}

pub trait GuessCache {
    fn get_guess(
        &self,
        place_id: &str,
        prompt_version: u32,
    ) -> impl Future<Output = Result<Option<CachedGuess>, StoreError>> + Send;

    fn put_guess(&self, guess: &CachedGuess)
    -> impl Future<Output = Result<(), StoreError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedLocation {
    pub location: Location,
    pub created_at: DateTime<Utc>,
}

pub trait GeocodeCache {
    /// `key` is [`crate::geo::normalise_address`] of the address.
    fn get_geocode(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<CachedLocation>, StoreError>> + Send;

    fn put_geocode(
        &self,
        key: &str,
        value: &CachedLocation,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

/// Whether a cached value created at `created_at` is still fresh at `now`.
pub fn is_fresh(created_at: DateTime<Utc>, ttl: Duration, now: DateTime<Utc>) -> bool {
    now - created_at < ttl
}

/// Record that a pick chose `candidate` (F7.4, F8.2): supersede any other `PICKED`
/// restaurant and mark this one `PICKED`, in one atomic change. `candidate` holds
/// the place details; a stored record's status and visit count win over it.
pub async fn record_pick<S: VisitStore + Sync>(
    store: &S,
    candidate: Restaurant,
    pick_id: &str,
    now: DateTime<Utc>,
) -> Result<Restaurant, StoreError> {
    let current_picked = store.currently_picked().await?;
    let base = match store.get_restaurant(&candidate.id).await? {
        Some(stored) => Restaurant {
            status: stored.status,
            status_before_pick: stored.status_before_pick,
            picked_at: stored.picked_at,
            visited_at: stored.visited_at,
            visit_count: stored.visit_count,
            pick_id: stored.pick_id,
            ..candidate
        },
        None => candidate,
    };
    let mut transitions = Vec::new();
    if let Some(other) = current_picked.as_ref().filter(|r| r.id != base.id) {
        transitions.push(status::apply(other, Event::Supersede, now)?);
    }
    let pick = status::apply(
        &base,
        Event::Pick {
            pick_id: pick_id.to_string(),
        },
        now,
    )?;
    let picked = pick.restaurant.clone();
    transitions.push(pick);
    store
        .apply(Change {
            transitions,
            expected_picked: current_picked.map(|r| r.id),
        })
        .await?;
    Ok(picked)
}

/// "We went here" (F8.2). `details` is required when the restaurant isn't stored yet.
pub async fn record_visit<S: VisitStore + Sync>(
    store: &S,
    id: &str,
    details: Option<Restaurant>,
    now: DateTime<Utc>,
) -> Result<Restaurant, StoreError> {
    let current = match store.get_restaurant(id).await? {
        Some(r) => r,
        None => details.ok_or(StoreError::NotFound)?,
    };
    change_one(store, &current, Event::Visit, now).await
}

/// "Skip" (F8.2).
pub async fn record_skip<S: VisitStore + Sync>(
    store: &S,
    id: &str,
    now: DateTime<Utc>,
) -> Result<Restaurant, StoreError> {
    let current = store
        .get_restaurant(id)
        .await?
        .ok_or(StoreError::NotFound)?;
    change_one(store, &current, Event::Skip, now).await
}

async fn change_one<S: VisitStore + Sync>(
    store: &S,
    current: &Restaurant,
    event: Event,
    now: DateTime<Utc>,
) -> Result<Restaurant, StoreError> {
    let expected_picked = store.currently_picked().await?.map(|r| r.id);
    let t = status::apply(current, event, now)?;
    let updated = t.restaurant.clone();
    store
        .apply(Change {
            transitions: vec![t],
            expected_picked,
        })
        .await?;
    Ok(updated)
}

/// The `PICKED` pointer after `change` (used by store implementations): the
/// restaurant that ends `PICKED`, else `None` if the old one left `PICKED`, else
/// unchanged.
pub fn picked_after(change: &Change) -> Option<String> {
    if let Some(t) = change
        .transitions
        .iter()
        .find(|t| t.restaurant.status == Some(Status::Picked))
    {
        return Some(t.restaurant.id.clone());
    }
    match &change.expected_picked {
        Some(id) if change.transitions.iter().any(|t| &t.restaurant.id == id) => None,
        other => other.clone(),
    }
}

/// The history sort key: `<RFC3339 ms timestamp>#<restaurant id>` (§4.2).
pub fn log_key(entry: &LogEntry) -> String {
    format!(
        "{}#{}",
        entry
            .at
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        entry.restaurant_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::tests::{now, restaurant};

    #[test]
    fn freshness() {
        assert!(is_fresh(now(), GEOCODE_TTL, now() + Duration::days(29)));
        assert!(!is_fresh(now(), GEOCODE_TTL, now() + Duration::days(30)));
    }

    #[test]
    fn picked_pointer_follows_the_change() {
        let pick = status::apply(
            &restaurant(None),
            Event::Pick {
                pick_id: "p".into(),
            },
            now(),
        )
        .unwrap();
        let change = Change {
            transitions: vec![pick.clone()],
            expected_picked: Some("other".into()),
        };
        assert_eq!(picked_after(&change).as_deref(), Some("osm:node/1"));

        let skip = status::apply(&pick.restaurant, Event::Skip, now()).unwrap();
        let change = Change {
            transitions: vec![skip],
            expected_picked: Some("osm:node/1".into()),
        };
        assert_eq!(picked_after(&change), None);

        let visit_other = status::apply(&restaurant(None), Event::Visit, now()).unwrap();
        let change = Change {
            transitions: vec![visit_other],
            expected_picked: Some("osm:node/9".into()),
        };
        assert_eq!(picked_after(&change).as_deref(), Some("osm:node/9"));
    }

    #[test]
    fn log_key_format() {
        let t = status::apply(&restaurant(None), Event::Visit, now()).unwrap();
        assert_eq!(log_key(&t.log), "2026-09-21T10:00:00.000Z#osm:node/1");
    }
}
