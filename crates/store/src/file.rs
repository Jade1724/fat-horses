//! JSON-file store for the CLI: the whole state in one file, rewritten atomically
//! after every change.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use domain::session::PickSession;
use domain::status::Restaurant;
use domain::store::{
    CachedGuess, CachedLocation, Change, CountryVisits, GeocodeCache, GuessCache, HistoryPage,
    PickStore, StoreError, VisitStore,
};

use crate::state::State;

#[derive(Debug)]
pub struct FileStore {
    path: PathBuf,
    state: Mutex<State>,
}

/// `$XDG_DATA_HOME/fat-horses/store.json`, else `~/.local/share/fat-horses/store.json`.
pub fn default_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("fat-horses").join("store.json"))
}

impl FileStore {
    /// Open the store at `path`, creating an empty one if the file doesn't exist.
    pub fn open(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        let state = match std::fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read<T>(&self, f: impl FnOnce(&State) -> T) -> T {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&state)
    }

    /// Apply `f` to a copy of the state, save it, then keep it. On any error the
    /// in-memory state and the file are left unchanged.
    fn write<T>(
        &self,
        f: impl FnOnce(&mut State) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = state.clone();
        let out = f(&mut next)?;
        save(&self.path, &next).map_err(|e| StoreError::Unavailable(e.to_string()))?;
        *state = next;
        Ok(out)
    }
}

fn save(path: &Path, state: &State) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

impl VisitStore for FileStore {
    async fn get_restaurant(&self, id: &str) -> Result<Option<Restaurant>, StoreError> {
        Ok(self.read(|s| s.restaurants.get(id).cloned()))
    }

    async fn currently_picked(&self) -> Result<Option<Restaurant>, StoreError> {
        Ok(self.read(|s| s.currently_picked()))
    }

    async fn apply(&self, change: Change) -> Result<(), StoreError> {
        self.write(|s| s.apply(change))
    }

    async fn country_visits(&self) -> Result<Vec<CountryVisits>, StoreError> {
        Ok(self.read(|s| s.country_visits()))
    }

    async fn history(
        &self,
        cursor: Option<String>,
        limit: usize,
    ) -> Result<HistoryPage, StoreError> {
        Ok(self.read(|s| s.history(cursor.as_deref(), limit)))
    }
}

impl PickStore for FileStore {
    async fn get_pick(&self, pick_id: &str) -> Result<Option<PickSession>, StoreError> {
        Ok(self.read(|s| s.picks.get(pick_id).cloned()))
    }

    async fn put_pick(&self, session: &PickSession) -> Result<(), StoreError> {
        self.write(|s| {
            s.picks.insert(session.pick_id.clone(), session.clone());
            Ok(())
        })
    }
}

impl GuessCache for FileStore {
    async fn get_guess(
        &self,
        place_id: &str,
        prompt_version: u32,
    ) -> Result<Option<CachedGuess>, StoreError> {
        Ok(self.read(|s| s.get_guess(place_id, prompt_version)))
    }

    async fn put_guess(&self, guess: &CachedGuess) -> Result<(), StoreError> {
        self.write(|s| {
            s.put_guess(guess);
            Ok(())
        })
    }
}

impl GeocodeCache for FileStore {
    async fn get_geocode(&self, key: &str) -> Result<Option<CachedLocation>, StoreError> {
        Ok(self.read(|s| s.geocodes.get(key).cloned()))
    }

    async fn put_geocode(&self, key: &str, value: &CachedLocation) -> Result<(), StoreError> {
        self.write(|s| {
            s.geocodes.insert(key.to_string(), value.clone());
            Ok(())
        })
    }
}
