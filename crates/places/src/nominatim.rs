//! Nominatim geocoder (SPEC.md F1.2, N4).

use std::time::Duration;

use domain::geo::{GeocodeError, Geocoder, Location};
use serde::Deserialize;
use tokio::sync::Mutex;
use tokio::time::Instant;

pub const DEFAULT_BASE_URL: &str = "https://nominatim.openstreetmap.org";
/// Nominatim's usage policy allows at most one request per second (N4).
pub const MIN_INTERVAL: Duration = Duration::from_secs(1);

pub struct Nominatim {
    http: reqwest::Client,
    base_url: String,
    last_request: Mutex<Option<Instant>>,
}

impl Nominatim {
    /// `http` must already carry the app's User-Agent (see [`crate::http_client`]).
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
            last_request: Mutex::new(None),
        }
    }

    /// Wait until at least [`MIN_INTERVAL`] has passed since the previous request.
    async fn throttle(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(wait) = wait_needed(*last, Instant::now()) {
            tokio::time::sleep(wait).await;
        }
        *last = Some(Instant::now());
    }
}

fn wait_needed(last: Option<Instant>, now: Instant) -> Option<Duration> {
    let elapsed = now.duration_since(last?);
    (elapsed < MIN_INTERVAL).then(|| MIN_INTERVAL - elapsed)
}

#[derive(Debug, Deserialize)]
struct SearchResult {
    lat: String,
    lon: String,
    display_name: String,
}

/// Parse a `format=jsonv2` search response; the first result wins (F1.2).
pub fn parse_search(body: &str) -> Result<Option<Location>, GeocodeError> {
    let results: Vec<SearchResult> = serde_json::from_str(body)
        .map_err(|e| GeocodeError::Unavailable(format!("bad Nominatim response: {e}")))?;
    let Some(first) = results.into_iter().next() else {
        return Ok(None);
    };
    let parse = |v: &str| {
        v.parse::<f64>()
            .map_err(|e| GeocodeError::Unavailable(format!("bad coordinate {v:?}: {e}")))
    };
    Ok(Some(Location {
        lat: parse(&first.lat)?,
        lon: parse(&first.lon)?,
        display_name: first.display_name,
    }))
}

impl Geocoder for Nominatim {
    async fn geocode(&self, address: &str) -> Result<Option<Location>, GeocodeError> {
        self.throttle().await;
        let resp = self
            .http
            .get(format!("{}/search", self.base_url))
            .query(&[("q", address), ("format", "jsonv2"), ("limit", "1")])
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| GeocodeError::Unavailable(e.to_string()))?;
        let body = resp
            .text()
            .await
            .map_err(|e| GeocodeError::Unavailable(e.to_string()))?;
        parse_search(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKY_TOWER: &str = include_str!("../tests/fixtures/nominatim/sky_tower.json");
    const NOT_FOUND: &str = include_str!("../tests/fixtures/nominatim/not_found.json");

    #[test]
    fn parses_first_result() {
        let loc = parse_search(SKY_TOWER).unwrap().unwrap();
        assert!((loc.lat - -36.848_463_2).abs() < 1e-6);
        assert!((loc.lon - 174.762_183).abs() < 1e-6);
        assert!(loc.display_name.starts_with("Sky Tower"));
    }

    #[test]
    fn empty_result_is_none() {
        assert!(parse_search(NOT_FOUND).unwrap().is_none());
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(parse_search("<html>").is_err());
        assert!(parse_search(r#"[{"lat":"x","lon":"1","display_name":"a"}]"#).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn waits_one_second_between_requests() {
        let t0 = Instant::now();
        assert_eq!(wait_needed(None, t0), None);
        assert_eq!(
            wait_needed(Some(t0), t0 + Duration::from_millis(300)),
            Some(Duration::from_millis(700))
        );
        assert_eq!(wait_needed(Some(t0), t0 + Duration::from_secs(1)), None);

        let n = Nominatim::new(reqwest::Client::new(), "http://unused");
        n.throttle().await;
        n.throttle().await;
        assert!(Instant::now() - t0 >= MIN_INTERVAL);
    }
}
