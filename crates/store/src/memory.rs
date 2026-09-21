//! In-memory store for tests and offline runs.

use std::sync::Mutex;

use domain::session::PickSession;
use domain::status::Restaurant;
use domain::store::{
    CachedGuess, CachedLocation, Change, CountryVisits, GeocodeCache, GuessCache, HistoryPage,
    PickStore, StoreError, VisitStore,
};

use crate::state::State;

#[derive(Debug, Default)]
pub struct MemoryStore {
    state: Mutex<State>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut state)
    }
}

impl VisitStore for MemoryStore {
    async fn get_restaurant(&self, id: &str) -> Result<Option<Restaurant>, StoreError> {
        Ok(self.with(|s| s.restaurants.get(id).cloned()))
    }

    async fn currently_picked(&self) -> Result<Option<Restaurant>, StoreError> {
        Ok(self.with(|s| s.currently_picked()))
    }

    async fn apply(&self, change: Change) -> Result<(), StoreError> {
        self.with(|s| s.apply(change))
    }

    async fn country_visits(&self) -> Result<Vec<CountryVisits>, StoreError> {
        Ok(self.with(|s| s.country_visits()))
    }

    async fn history(
        &self,
        cursor: Option<String>,
        limit: usize,
    ) -> Result<HistoryPage, StoreError> {
        Ok(self.with(|s| s.history(cursor.as_deref(), limit)))
    }
}

impl PickStore for MemoryStore {
    async fn get_pick(&self, pick_id: &str) -> Result<Option<PickSession>, StoreError> {
        Ok(self.with(|s| s.picks.get(pick_id).cloned()))
    }

    async fn put_pick(&self, session: &PickSession) -> Result<(), StoreError> {
        self.with(|s| s.picks.insert(session.pick_id.clone(), session.clone()));
        Ok(())
    }
}

impl GuessCache for MemoryStore {
    async fn get_guess(
        &self,
        place_id: &str,
        prompt_version: u32,
    ) -> Result<Option<CachedGuess>, StoreError> {
        Ok(self.with(|s| s.get_guess(place_id, prompt_version)))
    }

    async fn put_guess(&self, guess: &CachedGuess) -> Result<(), StoreError> {
        self.with(|s| s.put_guess(guess));
        Ok(())
    }
}

impl GeocodeCache for MemoryStore {
    async fn get_geocode(&self, key: &str) -> Result<Option<CachedLocation>, StoreError> {
        Ok(self.with(|s| s.geocodes.get(key).cloned()))
    }

    async fn put_geocode(&self, key: &str, value: &CachedLocation) -> Result<(), StoreError> {
        self.with(|s| s.geocodes.insert(key.to_string(), value.clone()));
        Ok(())
    }
}
