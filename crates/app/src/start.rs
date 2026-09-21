//! Starting a pick: validate the request and geocode it (SPEC.md F1).

use chrono::{DateTime, Utc};
use domain::geo::{Geocoder, Location, normalise_address};
use domain::pool::DEFAULT_MIN_POPULATION;
use domain::session::{PickRequest, PickSession};
use domain::store::{CachedLocation, GEOCODE_TTL, GeocodeCache, is_fresh};
use serde::Deserialize;

pub const DEFAULT_RADIUS_M: u32 = 200;
pub const RADIUS_RANGE: std::ops::RangeInclusive<u32> = 50..=2000;

/// The body of `POST /picks` (§5).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StartInput {
    pub address: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub radius_m: Option<u32>,
    pub min_population: Option<u64>,
    pub include_visited: Option<bool>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum StartError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("address not found")]
    AddressNotFound,
    #[error("geocoder unavailable: {0}")]
    GeocoderUnavailable(String),
}

/// Validate F1.1 and resolve the location (F1.2–F1.3). Returns a new session in
/// `finding_race`; the caller stores it and starts the workflow (F1.4).
pub async fn start_pick<G, C>(
    geocoder: &G,
    cache: &C,
    input: StartInput,
    pick_id: String,
    now: DateTime<Utc>,
) -> Result<PickSession, StartError>
where
    G: Geocoder + Sync,
    C: GeocodeCache + Sync,
{
    let radius_m = input.radius_m.unwrap_or(DEFAULT_RADIUS_M);
    if !RADIUS_RANGE.contains(&radius_m) {
        return Err(StartError::InvalidRequest(format!(
            "radius_m must be {}–{}",
            RADIUS_RANGE.start(),
            RADIUS_RANGE.end()
        )));
    }
    let request = PickRequest {
        radius_m,
        min_population: input.min_population.unwrap_or(DEFAULT_MIN_POPULATION),
        include_visited: input.include_visited.unwrap_or(false),
    };
    let address = input.address.filter(|a| !a.trim().is_empty());
    let location = match (address, input.lat, input.lon) {
        (Some(a), None, None) => geocode(geocoder, cache, &a, now).await?,
        (None, Some(lat), Some(lon)) => {
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                return Err(StartError::InvalidRequest("lat/lon out of range".into()));
            }
            Location {
                lat,
                lon,
                display_name: format!("{lat:.5}, {lon:.5}"),
            }
        }
        _ => {
            return Err(StartError::InvalidRequest(
                "give exactly one of address or lat+lon".into(),
            ));
        }
    };
    Ok(PickSession::new(pick_id, now, request, location))
}

async fn geocode<G, C>(
    geocoder: &G,
    cache: &C,
    address: &str,
    now: DateTime<Utc>,
) -> Result<Location, StartError>
where
    G: Geocoder + Sync,
    C: GeocodeCache + Sync,
{
    let key = normalise_address(address);
    if let Ok(Some(c)) = cache.get_geocode(&key).await
        && is_fresh(c.created_at, GEOCODE_TTL, now)
    {
        return Ok(c.location);
    }
    let location = geocoder
        .geocode(address)
        .await
        .map_err(|e| StartError::GeocoderUnavailable(e.to_string()))?
        .ok_or(StartError::AddressNotFound)?;
    let cached = CachedLocation {
        location: location.clone(),
        created_at: now,
    };
    if let Err(e) = cache.put_geocode(&key, &cached).await {
        tracing::warn!(error = %e, "geocode cache write failed");
    }
    Ok(location)
}

/// A new, time-ordered pick id (§1).
pub fn new_pick_id() -> String {
    ulid::Ulid::generate().to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use domain::geo::GeocodeError;
    use fat_horses_store::MemoryStore;

    use super::*;

    struct FakeGeocoder {
        calls: AtomicUsize,
    }

    impl Geocoder for FakeGeocoder {
        async fn geocode(&self, address: &str) -> Result<Option<Location>, GeocodeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match address {
                "down" => Err(GeocodeError::Unavailable("503".into())),
                a if a.contains("nowhere") => Ok(None),
                _ => Ok(Some(Location {
                    lat: -36.8485,
                    lon: 174.7622,
                    display_name: "Sky Tower, Auckland".into(),
                })),
            }
        }
    }

    fn geocoder() -> FakeGeocoder {
        FakeGeocoder {
            calls: AtomicUsize::new(0),
        }
    }

    fn now() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    fn address(a: &str) -> StartInput {
        StartInput {
            address: Some(a.into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn defaults_and_geocoding() {
        let s = start_pick(
            &geocoder(),
            &MemoryStore::new(),
            address("Sky Tower"),
            "p1".into(),
            now(),
        )
        .await
        .unwrap();
        assert_eq!(s.request.radius_m, 200);
        assert_eq!(s.request.min_population, 10_000_000);
        assert!(!s.request.include_visited);
        assert_eq!(s.location.display_name, "Sky Tower, Auckland");
        assert_eq!(s.pick_id, "p1");
    }

    #[tokio::test]
    async fn geocodes_are_cached_by_normalised_address() {
        let g = geocoder();
        let cache = MemoryStore::new();
        for a in ["Sky Tower", "  sky   TOWER "] {
            start_pick(&g, &cache, address(a), "p".into(), now())
                .await
                .unwrap();
        }
        assert_eq!(g.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn coordinates_skip_geocoding() {
        let g = geocoder();
        let input = StartInput {
            lat: Some(-36.8),
            lon: Some(174.7),
            radius_m: Some(500),
            ..Default::default()
        };
        let s = start_pick(&g, &MemoryStore::new(), input, "p".into(), now())
            .await
            .unwrap();
        assert_eq!(s.location.lat, -36.8);
        assert_eq!(s.request.radius_m, 500);
        assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn validation_errors() {
        let bad = [
            StartInput::default(),
            StartInput {
                address: Some("x".into()),
                lat: Some(1.0),
                lon: Some(1.0),
                ..Default::default()
            },
            StartInput {
                lat: Some(1.0),
                ..Default::default()
            },
            StartInput {
                lat: Some(91.0),
                lon: Some(0.0),
                ..Default::default()
            },
            StartInput {
                address: Some("Sky Tower".into()),
                radius_m: Some(49),
                ..Default::default()
            },
            StartInput {
                address: Some("Sky Tower".into()),
                radius_m: Some(2001),
                ..Default::default()
            },
        ];
        for input in bad {
            let r = start_pick(
                &geocoder(),
                &MemoryStore::new(),
                input.clone(),
                "p".into(),
                now(),
            )
            .await;
            assert!(
                matches!(r, Err(StartError::InvalidRequest(_))),
                "{input:?}: {r:?}"
            );
        }
    }

    #[tokio::test]
    async fn unknown_address_and_outage() {
        let r = start_pick(
            &geocoder(),
            &MemoryStore::new(),
            address("nowhere street"),
            "p".into(),
            now(),
        )
        .await;
        assert_eq!(r.unwrap_err(), StartError::AddressNotFound);
        let r = start_pick(
            &geocoder(),
            &MemoryStore::new(),
            address("down"),
            "p".into(),
            now(),
        )
        .await;
        assert!(matches!(r, Err(StartError::GeocoderUnavailable(_))));
    }

    #[test]
    fn pick_ids_are_ulids() {
        let id = new_pick_id();
        assert_eq!(id.len(), 26);
        assert_ne!(id, new_pick_id());
    }
}
