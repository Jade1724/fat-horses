//! In-process store state shared by the memory and JSON-file stores.

use std::collections::{BTreeMap, HashMap};

use domain::session::PickSession;
use domain::status::Restaurant;
use domain::store::{
    CachedGuess, CachedLocation, Change, CountryVisits, HistoryPage, StoreError, log_key,
    picked_after,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct State {
    pub restaurants: HashMap<String, Restaurant>,
    pub picked: Option<String>,
    pub countries: HashMap<String, CountryVisits>,
    /// Keyed by [`log_key`]; iterated in reverse for newest first.
    pub log: BTreeMap<String, domain::status::LogEntry>,
    pub picks: HashMap<String, PickSession>,
    /// Keyed by `"<place_id>#v<prompt_version>"`.
    pub guesses: HashMap<String, CachedGuess>,
    pub geocodes: HashMap<String, CachedLocation>,
}

fn guess_key(place_id: &str, prompt_version: u32) -> String {
    format!("{place_id}#v{prompt_version}")
}

impl State {
    pub fn currently_picked(&self) -> Option<Restaurant> {
        self.picked
            .as_ref()
            .and_then(|id| self.restaurants.get(id))
            .cloned()
    }

    /// Check every condition first, then write everything (all or nothing).
    pub fn apply(&mut self, change: Change) -> Result<(), StoreError> {
        if self.picked != change.expected_picked {
            return Err(StoreError::Conflict);
        }
        for t in &change.transitions {
            let stored = self
                .restaurants
                .get(&t.restaurant.id)
                .and_then(|r| r.status);
            if stored != t.expected_status {
                return Err(StoreError::Conflict);
            }
        }
        self.picked = picked_after(&change);
        for t in change.transitions {
            if t.country_visited {
                let c = self
                    .countries
                    .entry(t.log.country_iso.clone())
                    .or_insert_with(|| CountryVisits {
                        iso2: t.log.country_iso.clone(),
                        visit_count: 0,
                        first_visited_at: None,
                        last_visited_at: None,
                    });
                c.visit_count += 1;
                c.first_visited_at.get_or_insert(t.log.at);
                c.last_visited_at = Some(t.log.at);
            }
            self.log.insert(log_key(&t.log), t.log);
            self.restaurants
                .insert(t.restaurant.id.clone(), t.restaurant);
        }
        Ok(())
    }

    pub fn country_visits(&self) -> Vec<CountryVisits> {
        let mut out: Vec<CountryVisits> = self.countries.values().cloned().collect();
        out.sort_by(|a, b| a.iso2.cmp(&b.iso2));
        out
    }

    pub fn history(&self, cursor: Option<&str>, limit: usize) -> HistoryPage {
        let older = self.log.iter().rev().filter(|(k, _)| match cursor {
            Some(c) => k.as_str() < c,
            None => true,
        });
        let page: Vec<(&String, &domain::status::LogEntry)> = older.take(limit + 1).collect();
        let has_more = page.len() > limit;
        let page = &page[..page.len().min(limit)];
        HistoryPage {
            entries: page.iter().map(|(_, e)| (*e).clone()).collect(),
            next_cursor: if has_more {
                page.last().map(|(k, _)| (*k).clone())
            } else {
                None
            },
        }
    }

    pub fn get_guess(&self, place_id: &str, prompt_version: u32) -> Option<CachedGuess> {
        self.guesses
            .get(&guess_key(place_id, prompt_version))
            .cloned()
    }

    pub fn put_guess(&mut self, guess: &CachedGuess) {
        self.guesses.insert(
            guess_key(&guess.guess.place_id, guess.prompt_version),
            guess.clone(),
        );
    }
}
