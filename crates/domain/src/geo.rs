//! Geocoding (SPEC.md F1.2–F1.3) and distances.

use std::future::Future;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
    pub display_name: String,
}

#[derive(Debug, thiserror::Error)]
pub enum GeocodeError {
    #[error("geocoder unavailable: {0}")]
    Unavailable(String),
}

/// Turns a free-text address into a location. `Ok(None)` means no match (F1.2).
pub trait Geocoder {
    fn geocode(
        &self,
        address: &str,
    ) -> impl Future<Output = Result<Option<Location>, GeocodeError>> + Send;
}

/// Cache key for an address (F1.3): lowercase, whitespace collapsed.
pub fn normalise_address(address: &str) -> String {
    address
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Great-circle distance in metres (haversine).
pub fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_008.8;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_case_and_whitespace() {
        assert_eq!(
            normalise_address("  1 Queen   Street,\tAuckland "),
            "1 queen street, auckland"
        );
    }

    #[test]
    fn distance_zero_and_known() {
        assert_eq!(distance_m(-36.8485, 174.7633, -36.8485, 174.7633), 0.0);
        // One degree of latitude is about 111.2 km.
        let d = distance_m(0.0, 0.0, 1.0, 0.0);
        assert!((d - 111_195.0).abs() < 50.0, "{d}");
    }
}
