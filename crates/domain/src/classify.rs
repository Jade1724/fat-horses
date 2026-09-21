//! The LLM classifier interface and its output validation (SPEC.md §3).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use crate::places::Place;

/// Longest reason kept from the model (L4).
pub const MAX_REASON_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CuisineGuess {
    pub tag: String,
    pub confidence: f64,
}

/// The classifier's cuisine guess for one untagged place (L2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Guess {
    pub place_id: String,
    pub cuisines: Vec<CuisineGuess>,
    pub reason: String,
}

/// A place the classifier thinks serves the country's dishes (F6.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DishMatch {
    pub place_id: String,
    pub reason: String,
}

/// What the classifier may see about a place: public OSM data only (L3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceInput {
    pub place_id: String,
    pub name: String,
    pub amenity: String,
    pub cuisine: Vec<String>,
    pub tags: BTreeMap<String, String>,
}

impl From<&Place> for PlaceInput {
    fn from(p: &Place) -> Self {
        Self {
            place_id: p.id.clone(),
            name: p.name.clone(),
            amenity: p.amenity.clone(),
            cuisine: p.cuisine.clone(),
            tags: p.tags.clone(),
        }
    }
}

/// The winning country as the classifier sees it (L3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountryDishes {
    pub name: String,
    pub dishes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClassifyError {
    #[error("classifier unavailable: {0}")]
    Unavailable(String),
    #[error("classifier output invalid: {0}")]
    InvalidOutput(String),
}

pub trait Classifier {
    /// Guess cuisines for places without a `cuisine` tag (F6.3).
    fn guess_cuisines(
        &self,
        places: &[PlaceInput],
    ) -> impl Future<Output = Result<Vec<Guess>, ClassifyError>> + Send;

    /// Places likely to serve the country's dishes (F6.5).
    fn match_dishes(
        &self,
        places: &[PlaceInput],
        country: &CountryDishes,
    ) -> impl Future<Output = Result<Vec<DishMatch>, ClassifyError>> + Send;
}

#[derive(Debug, Deserialize)]
struct RawGuesses {
    guesses: Vec<RawGuess>,
}

#[derive(Debug, Deserialize)]
struct RawGuess {
    place_id: String,
    #[serde(default)]
    cuisines: Vec<CuisineGuess>,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize)]
struct RawMatches {
    matches: Vec<DishMatch>,
}

fn clamp_reason(reason: &str) -> String {
    let r = reason.trim();
    if r.chars().count() <= MAX_REASON_CHARS {
        r.to_string()
    } else {
        let cut: String = r.chars().take(MAX_REASON_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Validate `guess_cuisines` output (L4): drop entries for unknown places, tags
/// outside `known_tags` and confidences outside [0, 1]; keep one guess per place;
/// clamp reasons. Unparseable JSON is an error.
pub fn validate_guesses(
    json: &str,
    input_ids: &HashSet<&str>,
    known_tags: &HashSet<&str>,
) -> Result<Vec<Guess>, ClassifyError> {
    let raw: RawGuesses =
        serde_json::from_str(json).map_err(|e| ClassifyError::InvalidOutput(e.to_string()))?;
    let mut seen = HashSet::new();
    Ok(raw
        .guesses
        .into_iter()
        .filter(|g| input_ids.contains(g.place_id.as_str()))
        .filter(|g| seen.insert(g.place_id.clone()))
        .map(|g| Guess {
            cuisines: g
                .cuisines
                .into_iter()
                .map(|c| CuisineGuess {
                    tag: c.tag.trim().to_lowercase(),
                    confidence: c.confidence,
                })
                .filter(|c| known_tags.contains(c.tag.as_str()))
                .filter(|c| (0.0..=1.0).contains(&c.confidence))
                .collect(),
            reason: clamp_reason(&g.reason),
            place_id: g.place_id,
        })
        .collect())
}

/// Validate `match_dishes` output (L4): only known places, once each, reasons clamped.
pub fn validate_dish_matches(
    json: &str,
    input_ids: &HashSet<&str>,
) -> Result<Vec<DishMatch>, ClassifyError> {
    let raw: RawMatches =
        serde_json::from_str(json).map_err(|e| ClassifyError::InvalidOutput(e.to_string()))?;
    let mut seen = HashSet::new();
    Ok(raw
        .matches
        .into_iter()
        .filter(|m| input_ids.contains(m.place_id.as_str()))
        .filter(|m| seen.insert(m.place_id.clone()))
        .map(|m| DishMatch {
            reason: clamp_reason(&m.reason),
            place_id: m.place_id,
        })
        .collect())
}

/// A deterministic classifier for tests and offline runs (L2). Returns the
/// configured answers for the places it is asked about.
#[derive(Debug, Default)]
pub struct FakeClassifier {
    guesses: HashMap<String, Guess>,
    /// Country name → matches.
    dish_matches: HashMap<String, Vec<DishMatch>>,
    fail: bool,
    guess_calls: AtomicUsize,
    guessed_places: Mutex<Vec<String>>,
    dish_calls: AtomicUsize,
}

impl FakeClassifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every call fails with [`ClassifyError::Unavailable`].
    pub fn failing() -> Self {
        Self {
            fail: true,
            ..Self::default()
        }
    }

    pub fn with_guess(mut self, guess: Guess) -> Self {
        self.guesses.insert(guess.place_id.clone(), guess);
        self
    }

    pub fn with_dish_match(mut self, country: &str, place_id: &str, reason: &str) -> Self {
        self.dish_matches
            .entry(country.to_string())
            .or_default()
            .push(DishMatch {
                place_id: place_id.into(),
                reason: reason.into(),
            });
        self
    }

    pub fn guess_calls(&self) -> usize {
        self.guess_calls.load(Ordering::SeqCst)
    }

    /// Place ids sent to `guess_cuisines`, across all calls.
    pub fn guessed_places(&self) -> Vec<String> {
        self.guessed_places
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn dish_calls(&self) -> usize {
        self.dish_calls.load(Ordering::SeqCst)
    }
}

impl Classifier for FakeClassifier {
    async fn guess_cuisines(&self, places: &[PlaceInput]) -> Result<Vec<Guess>, ClassifyError> {
        self.guess_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(ClassifyError::Unavailable("fake failure".into()));
        }
        self.guessed_places
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(places.iter().map(|p| p.place_id.clone()));
        Ok(places
            .iter()
            .filter_map(|p| self.guesses.get(&p.place_id).cloned())
            .collect())
    }

    async fn match_dishes(
        &self,
        places: &[PlaceInput],
        country: &CountryDishes,
    ) -> Result<Vec<DishMatch>, ClassifyError> {
        self.dish_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(ClassifyError::Unavailable("fake failure".into()));
        }
        let ids: HashSet<&str> = places.iter().map(|p| p.place_id.as_str()).collect();
        Ok(self
            .dish_matches
            .get(&country.name)
            .map(|ms| {
                ms.iter()
                    .filter(|m| ids.contains(m.place_id.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> HashSet<&'static str> {
        HashSet::from(["osm:node/1", "osm:node/2"])
    }

    fn tags() -> HashSet<&'static str> {
        HashSet::from(["japanese", "sushi", "italian"])
    }

    #[test]
    fn keeps_valid_guesses() {
        let json = r#"{"guesses":[
            {"place_id":"osm:node/1","cuisines":[{"tag":"japanese","confidence":0.9}],"reason":"Name is Sakura Sushi"}
        ]}"#;
        let g = validate_guesses(json, &ids(), &tags()).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].cuisines[0].tag, "japanese");
        assert_eq!(g[0].reason, "Name is Sakura Sushi");
    }

    #[test]
    fn drops_unknown_place_ids() {
        let json = r#"{"guesses":[
            {"place_id":"osm:node/99","cuisines":[{"tag":"japanese","confidence":0.9}],"reason":"x"},
            {"place_id":"osm:node/2","cuisines":[],"reason":"unknown"}
        ]}"#;
        let g = validate_guesses(json, &ids(), &tags()).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].place_id, "osm:node/2");
    }

    #[test]
    fn drops_unknown_tags_and_bad_confidence() {
        let json = r#"{"guesses":[{"place_id":"osm:node/1","cuisines":[
            {"tag":"Japanese","confidence":0.8},
            {"tag":"martian","confidence":0.9},
            {"tag":"sushi","confidence":1.5},
            {"tag":"italian","confidence":-0.1}
        ],"reason":"x"}]}"#;
        let g = validate_guesses(json, &ids(), &tags()).unwrap();
        assert_eq!(
            g[0].cuisines,
            [CuisineGuess {
                tag: "japanese".into(),
                confidence: 0.8
            }]
        );
    }

    #[test]
    fn one_guess_per_place() {
        let json = r#"{"guesses":[
            {"place_id":"osm:node/1","cuisines":[],"reason":"first"},
            {"place_id":"osm:node/1","cuisines":[],"reason":"second"}
        ]}"#;
        let g = validate_guesses(json, &ids(), &tags()).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].reason, "first");
    }

    #[test]
    fn clamps_long_reasons() {
        let long = "x".repeat(300);
        let json = format!(
            r#"{{"guesses":[{{"place_id":"osm:node/1","cuisines":[],"reason":"{long}"}}]}}"#
        );
        let g = validate_guesses(&json, &ids(), &tags()).unwrap();
        assert_eq!(g[0].reason.chars().count(), MAX_REASON_CHARS);
        assert!(g[0].reason.ends_with('…'));
    }

    #[test]
    fn bad_json_is_an_error() {
        for bad in ["", "not json", r#"{"guesses": "no"}"#, r#"{"other": []}"#] {
            assert!(
                matches!(
                    validate_guesses(bad, &ids(), &tags()),
                    Err(ClassifyError::InvalidOutput(_))
                ),
                "{bad:?}"
            );
        }
        assert!(validate_dish_matches("[]", &ids()).is_err());
    }

    #[test]
    fn dish_matches_validated() {
        let json = r#"{"matches":[
            {"place_id":"osm:node/2","reason":"Serves raclette"},
            {"place_id":"osm:node/2","reason":"dup"},
            {"place_id":"osm:node/7","reason":"unknown"}
        ]}"#;
        let m = validate_dish_matches(json, &ids()).unwrap();
        assert_eq!(
            m,
            [DishMatch {
                place_id: "osm:node/2".into(),
                reason: "Serves raclette".into()
            }]
        );
    }

    fn input(id: &str) -> PlaceInput {
        PlaceInput {
            place_id: id.into(),
            name: "n".into(),
            amenity: "restaurant".into(),
            cuisine: vec![],
            tags: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn fake_returns_configured_answers() {
        let fake = FakeClassifier::new()
            .with_guess(Guess {
                place_id: "osm:node/1".into(),
                cuisines: vec![],
                reason: "r".into(),
            })
            .with_dish_match("Switzerland", "osm:node/2", "fondue")
            .with_dish_match("Switzerland", "osm:node/3", "not asked");
        let places = [input("osm:node/1"), input("osm:node/2")];
        let g = fake.guess_cuisines(&places).await.unwrap();
        assert_eq!(g.len(), 1);
        let swiss = CountryDishes {
            name: "Switzerland".into(),
            dishes: vec!["fondue".into()],
        };
        let m = fake.match_dishes(&places, &swiss).await.unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(fake.guess_calls(), 1);
        assert_eq!(fake.dish_calls(), 1);
        assert_eq!(fake.guessed_places(), ["osm:node/1", "osm:node/2"]);
    }

    #[tokio::test]
    async fn failing_fake_fails() {
        let fake = FakeClassifier::failing();
        assert!(fake.guess_cuisines(&[input("a")]).await.is_err());
    }
}
