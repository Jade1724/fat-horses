//! Cuisine guesses for untagged places, with caching (SPEC.md F6.3, L5, L6).

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::classify::{Classifier, Guess, PlaceInput};
use crate::places::Place;
use crate::store::{CachedGuess, GUESS_TTL, GuessCache, is_fresh};

/// Places per classifier call (L5).
pub const BATCH_SIZE: usize = 50;
/// Most places classified per pick, closest first (L5).
pub const MAX_PLACES: usize = 200;

/// Which prompt and model produced a guess; part of the cache key (L6, L7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuessConfig {
    pub prompt_version: u32,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GuessOutcome {
    pub guesses: Vec<Guess>,
    /// Some batch failed (classifier or cache); its places have no guess (F6.8).
    pub llm_unavailable: bool,
}

/// SHA-256 of the place's name, amenity and sorted tags (L6): a changed place is
/// guessed again.
pub fn input_hash(p: &PlaceInput) -> String {
    let mut h = Sha256::new();
    h.update(p.name.as_bytes());
    h.update([0]);
    h.update(p.amenity.as_bytes());
    for (k, v) in &p.tags {
        h.update([0]);
        h.update(k.as_bytes());
        h.update([1]);
        h.update(v.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Guesses for every untagged place in `places` (up to [`MAX_PLACES`], closest
/// first): fresh cached guesses with a matching input hash are reused, the rest go
/// to the classifier in batches of [`BATCH_SIZE`] and are cached. A place the
/// classifier skipped is cached with no cuisines so it isn't asked about again.
/// Failures never abort: they set `llm_unavailable` and leave those places unguessed.
pub async fn guess_untagged<C, G>(
    places: &[Place],
    classifier: &C,
    cache: &G,
    config: &GuessConfig,
    now: DateTime<Utc>,
) -> GuessOutcome
where
    C: Classifier + Sync,
    G: GuessCache + Sync,
{
    let mut untagged: Vec<&Place> = places.iter().filter(|p| !p.is_tagged()).collect();
    untagged.sort_by(|a, b| a.distance_m.total_cmp(&b.distance_m));
    untagged.truncate(MAX_PLACES);

    let mut out = GuessOutcome::default();
    let mut to_ask: Vec<(PlaceInput, String)> = Vec::new();
    for p in untagged {
        let input = PlaceInput::from(p);
        let hash = input_hash(&input);
        match cache.get_guess(&p.id, config.prompt_version).await {
            Ok(Some(c)) if c.input_hash == hash && is_fresh(c.created_at, GUESS_TTL, now) => {
                out.guesses.push(c.guess);
            }
            Ok(_) => to_ask.push((input, hash)),
            Err(e) => {
                tracing::warn!(error = %e, "guess cache read failed");
                to_ask.push((input, hash));
            }
        }
    }

    for batch in to_ask.chunks(BATCH_SIZE) {
        let inputs: Vec<PlaceInput> = batch.iter().map(|(i, _)| i.clone()).collect();
        let answered = match classifier.guess_cuisines(&inputs).await {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!(error = %e, "cuisine guessing failed");
                out.llm_unavailable = true;
                continue;
            }
        };
        for (input, hash) in batch {
            let guess = answered
                .iter()
                .find(|g| g.place_id == input.place_id)
                .cloned()
                .unwrap_or_else(|| Guess {
                    place_id: input.place_id.clone(),
                    cuisines: Vec::new(),
                    reason: String::new(),
                });
            let cached = CachedGuess {
                guess: guess.clone(),
                prompt_version: config.prompt_version,
                input_hash: hash.clone(),
                model_id: config.model_id.clone(),
                created_at: now,
            };
            if let Err(e) = cache.put_guess(&cached).await {
                tracing::warn!(error = %e, "guess cache write failed");
            }
            out.guesses.push(guess);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use chrono::Duration;

    use super::*;
    use crate::classify::{CuisineGuess, FakeClassifier};
    use crate::matching::tests::place;
    use crate::store::StoreError;

    #[derive(Default)]
    struct Cache(Mutex<HashMap<(String, u32), CachedGuess>>);

    impl GuessCache for Cache {
        async fn get_guess(
            &self,
            place_id: &str,
            prompt_version: u32,
        ) -> Result<Option<CachedGuess>, StoreError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&(place_id.to_string(), prompt_version))
                .cloned())
        }

        async fn put_guess(&self, g: &CachedGuess) -> Result<(), StoreError> {
            self.0
                .lock()
                .unwrap()
                .insert((g.guess.place_id.clone(), g.prompt_version), g.clone());
            Ok(())
        }
    }

    fn now() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    fn config(v: u32) -> GuessConfig {
        GuessConfig {
            prompt_version: v,
            model_id: "fake".into(),
        }
    }

    fn g(id: &str, tag: &str) -> Guess {
        Guess {
            place_id: id.into(),
            cuisines: vec![CuisineGuess {
                tag: tag.into(),
                confidence: 0.9,
            }],
            reason: "name".into(),
        }
    }

    fn untagged(n: usize) -> Vec<Place> {
        (0..n)
            .map(|i| {
                let mut p = place(&format!("osm:node/{i}"), "");
                p.distance_m = i as f64;
                p
            })
            .collect()
    }

    #[tokio::test]
    async fn only_untagged_places_are_asked() {
        let places = [place("osm:node/1", ""), place("osm:node/2", "thai")];
        let fake = FakeClassifier::new().with_guess(g("osm:node/1", "japanese"));
        let out = guess_untagged(&places, &fake, &Cache::default(), &config(1), now()).await;
        assert_eq!(out.guesses, [g("osm:node/1", "japanese")]);
        assert_eq!(fake.guessed_places(), ["osm:node/1"]);
        assert!(!out.llm_unavailable);
    }

    #[tokio::test]
    async fn cached_guesses_are_reused() {
        let places = [place("osm:node/1", "")];
        let fake = FakeClassifier::new().with_guess(g("osm:node/1", "japanese"));
        let cache = Cache::default();
        guess_untagged(&places, &fake, &cache, &config(1), now()).await;
        let out = guess_untagged(&places, &fake, &cache, &config(1), now()).await;
        assert_eq!(fake.guess_calls(), 1);
        assert_eq!(out.guesses, [g("osm:node/1", "japanese")]);
    }

    #[tokio::test]
    async fn changed_place_or_prompt_or_age_is_guessed_again() {
        let mut places = vec![place("osm:node/1", "")];
        let fake = FakeClassifier::new().with_guess(g("osm:node/1", "japanese"));
        let cache = Cache::default();
        guess_untagged(&places, &fake, &cache, &config(1), now()).await;

        places[0].name = "Renamed".into();
        guess_untagged(&places, &fake, &cache, &config(1), now()).await;
        assert_eq!(fake.guess_calls(), 2, "name change");

        guess_untagged(&places, &fake, &cache, &config(2), now()).await;
        assert_eq!(fake.guess_calls(), 3, "new prompt version");

        guess_untagged(
            &places,
            &fake,
            &cache,
            &config(2),
            now() + Duration::days(181),
        )
        .await;
        assert_eq!(fake.guess_calls(), 4, "expired");
    }

    #[tokio::test]
    async fn skipped_places_are_cached_empty() {
        let places = [place("osm:node/1", "")];
        let fake = FakeClassifier::new();
        let cache = Cache::default();
        let out = guess_untagged(&places, &fake, &cache, &config(1), now()).await;
        assert!(out.guesses[0].cuisines.is_empty());
        guess_untagged(&places, &fake, &cache, &config(1), now()).await;
        assert_eq!(fake.guess_calls(), 1);
    }

    #[tokio::test]
    async fn batches_of_fifty_capped_at_two_hundred_closest() {
        let places = untagged(230);
        let fake = FakeClassifier::new();
        let out = guess_untagged(&places, &fake, &Cache::default(), &config(1), now()).await;
        assert_eq!(fake.guess_calls(), 4);
        assert_eq!(out.guesses.len(), 200);
        let asked = fake.guessed_places();
        assert!(asked.contains(&"osm:node/199".to_string()));
        assert!(!asked.contains(&"osm:node/200".to_string()));
    }

    #[tokio::test]
    async fn failure_marks_llm_unavailable() {
        let places = untagged(3);
        let fake = FakeClassifier::failing();
        let out = guess_untagged(&places, &fake, &Cache::default(), &config(1), now()).await;
        assert!(out.llm_unavailable);
        assert!(out.guesses.is_empty());
    }

    #[test]
    fn hash_depends_on_name_and_tags() {
        let p = PlaceInput::from(&place("osm:node/1", ""));
        let mut q = p.clone();
        assert_eq!(input_hash(&p), input_hash(&q));
        q.tags.insert("website".into(), "x".into());
        assert_ne!(input_hash(&p), input_hash(&q));
        assert_eq!(input_hash(&p).len(), 64);
    }
}
