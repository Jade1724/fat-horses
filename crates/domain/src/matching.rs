//! Matching places to the winning country (SPEC.md F6.2–F6.4).

use serde::{Deserialize, Serialize};

use crate::classify::Guess;
use crate::countries::Country;
use crate::places::Place;

/// Default confidence needed for an inferred match (F6.3).
pub const DEFAULT_CONFIDENCE_THRESHOLD: f64 = 0.7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    Tagged,
    Inferred,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Match {
    pub place_id: String,
    #[serde(rename = "match")]
    pub kind: MatchKind,
    /// The LLM's one-line reason, for `Inferred` and `Fallback`.
    pub reason: Option<String>,
}

fn country_has_tag(country: &Country, tag: &str) -> bool {
    country.cuisine_tags.iter().any(|t| t == tag)
}

/// Tier 1 (F6.2): the place's own `cuisine` tag matches the country.
pub fn tagged_matches(places: &[Place], country: &Country) -> Vec<Match> {
    places
        .iter()
        .filter(|p| p.cuisine.iter().any(|t| country_has_tag(country, t)))
        .map(|p| Match {
            place_id: p.id.clone(),
            kind: MatchKind::Tagged,
            reason: None,
        })
        .collect()
}

/// Tier 2 (F6.3): untagged places whose guessed cuisine matches the country with
/// at least `threshold` confidence. Tagged places are never inferred.
pub fn inferred_matches(
    places: &[Place],
    guesses: &[Guess],
    country: &Country,
    threshold: f64,
) -> Vec<Match> {
    places
        .iter()
        .filter(|p| !p.is_tagged())
        .filter_map(|p| {
            let guess = guesses.iter().find(|g| g.place_id == p.id)?;
            guess
                .cuisines
                .iter()
                .any(|c| c.confidence >= threshold && country_has_tag(country, &c.tag))
                .then(|| Match {
                    place_id: p.id.clone(),
                    kind: MatchKind::Inferred,
                    reason: Some(guess.reason.clone()),
                })
        })
        .collect()
}

/// Tiers 1 and 2 together: the primary matches (F6.4).
pub fn primary_matches(
    places: &[Place],
    guesses: &[Guess],
    country: &Country,
    threshold: f64,
) -> Vec<Match> {
    let mut out = tagged_matches(places, country);
    out.extend(inferred_matches(places, guesses, country, threshold));
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::classify::CuisineGuess;
    use crate::places::parse_cuisine;

    pub fn place(id: &str, cuisine: &str) -> Place {
        Place {
            id: id.into(),
            name: format!("Place {id}"),
            lat: -36.85,
            lon: 174.76,
            address: None,
            amenity: "restaurant".into(),
            cuisine: parse_cuisine(cuisine),
            tags: BTreeMap::new(),
            distance_m: 100.0,
        }
    }

    pub fn japan() -> Country {
        Country {
            iso2: "JP".into(),
            name: "Japan".into(),
            flag: "🇯🇵".into(),
            population: 123_000_000,
            cuisine_tags: vec!["japanese".into(), "sushi".into(), "ramen".into()],
            dishes: vec!["sushi".into(), "ramen".into(), "tempura".into()],
        }
    }

    fn guess(id: &str, tags: &[(&str, f64)]) -> Guess {
        Guess {
            place_id: id.into(),
            cuisines: tags
                .iter()
                .map(|&(tag, confidence)| CuisineGuess {
                    tag: tag.into(),
                    confidence,
                })
                .collect(),
            reason: format!("reason for {id}"),
        }
    }

    fn ids(ms: &[Match]) -> Vec<&str> {
        ms.iter().map(|m| m.place_id.as_str()).collect()
    }

    #[test]
    fn tagged_matches_any_cuisine_value() {
        let places = [
            place("osm:node/1", "Japanese; sushi"),
            place("osm:way/2", "ramen"),
            place("osm:node/3", "italian;pizza"),
            place("osm:node/4", ""),
        ];
        let ms = tagged_matches(&places, &japan());
        assert_eq!(ids(&ms), ["osm:node/1", "osm:way/2"]);
        assert!(
            ms.iter()
                .all(|m| m.kind == MatchKind::Tagged && m.reason.is_none())
        );
    }

    #[test]
    fn inferred_at_or_above_threshold() {
        let places = [
            place("osm:node/1", ""),
            place("osm:node/2", ""),
            place("osm:node/3", ""),
        ];
        let guesses = [
            guess("osm:node/1", &[("japanese", 0.7)]),
            guess("osm:node/2", &[("japanese", 0.69)]),
            guess("osm:node/3", &[("italian", 0.95), ("sushi", 0.8)]),
        ];
        let ms = inferred_matches(&places, &guesses, &japan(), DEFAULT_CONFIDENCE_THRESHOLD);
        assert_eq!(ids(&ms), ["osm:node/1", "osm:node/3"]);
        assert_eq!(ms[0].kind, MatchKind::Inferred);
        assert_eq!(ms[0].reason.as_deref(), Some("reason for osm:node/1"));
    }

    #[test]
    fn tagged_places_are_never_inferred() {
        let places = [place("osm:node/1", "italian")];
        let guesses = [guess("osm:node/1", &[("japanese", 0.99)])];
        assert!(inferred_matches(&places, &guesses, &japan(), 0.7).is_empty());
    }

    #[test]
    fn untagged_place_without_a_guess_is_skipped() {
        let places = [place("osm:node/1", "")];
        assert!(inferred_matches(&places, &[], &japan(), 0.7).is_empty());
    }

    #[test]
    fn primary_is_tagged_then_inferred() {
        let places = [place("osm:node/1", ""), place("osm:node/2", "sushi")];
        let guesses = [guess("osm:node/1", &[("ramen", 0.9)])];
        let ms = primary_matches(&places, &guesses, &japan(), 0.7);
        assert_eq!(ids(&ms), ["osm:node/2", "osm:node/1"]);
        assert_eq!(ms[0].kind, MatchKind::Tagged);
        assert_eq!(ms[1].kind, MatchKind::Inferred);
    }
}
