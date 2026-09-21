//! Places near the pick location (SPEC.md F6.1).

use std::collections::BTreeMap;
use std::future::Future;

use serde::{Deserialize, Serialize};

/// Default OSM `amenity` values that count as restaurants (F6.1).
pub const DEFAULT_AMENITIES: &[&str] = &["restaurant", "fast_food"];

#[derive(Debug, thiserror::Error)]
pub enum PlacesError {
    #[error("places source unavailable: {0}")]
    Unavailable(String),
}

/// Finds restaurant-like places around a point (F6.1), nearest first.
pub trait Places {
    fn nearby(
        &self,
        lat: f64,
        lon: f64,
        radius_m: u32,
        amenities: &[&str],
    ) -> impl Future<Output = Result<Vec<Place>, PlacesError>> + Send;
}

/// A restaurant-like OSM node or way inside the radius.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Place {
    /// `osm:<type>/<id>`, e.g. `osm:node/123`.
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// Street address built from `addr:*` tags, if any.
    pub address: Option<String>,
    /// OSM `amenity` value (`restaurant`, `fast_food`, ...).
    pub amenity: String,
    /// Parsed OSM `cuisine` values; empty when the place has no cuisine tag.
    pub cuisine: Vec<String>,
    /// Other public OSM tags worth showing the classifier (`website`, `menu`, `description`, ...).
    pub tags: BTreeMap<String, String>,
    /// Distance from the pick location, in metres.
    pub distance_m: f64,
}

impl Place {
    pub fn osm_id(kind: &str, id: u64) -> String {
        format!("osm:{kind}/{id}")
    }

    pub fn is_tagged(&self) -> bool {
        !self.cuisine.is_empty()
    }
}

/// Parse an OSM `cuisine` value: `;`-separated, trimmed, lowercased, empty parts
/// dropped, duplicates removed (order kept). Spaces inside a value become `_`
/// so `"South African"` matches the tag `south_african`.
pub fn parse_cuisine(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(';') {
        let v = part
            .trim()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("_");
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_trims_and_lowercases() {
        assert_eq!(parse_cuisine("Japanese; sushi"), ["japanese", "sushi"]);
        assert_eq!(parse_cuisine(" ramen ;;UDON; "), ["ramen", "udon"]);
    }

    #[test]
    fn spaces_inside_a_value_become_underscores() {
        assert_eq!(parse_cuisine("South African"), ["south_african"]);
    }

    #[test]
    fn removes_duplicates() {
        assert_eq!(parse_cuisine("thai;Thai; thai"), ["thai"]);
    }

    #[test]
    fn empty_is_empty() {
        assert!(parse_cuisine("").is_empty());
        assert!(parse_cuisine(" ; ").is_empty());
    }

    #[test]
    fn osm_ids() {
        assert_eq!(Place::osm_id("node", 123), "osm:node/123");
        assert_eq!(Place::osm_id("way", 9), "osm:way/9");
    }
}
