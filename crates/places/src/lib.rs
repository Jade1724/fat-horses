//! Nominatim geocoder and Overpass places client (SPEC.md F1.2, F6.1).

pub mod nominatim;
pub mod overpass;

use std::time::Duration;

/// An HTTP client with the app's User-Agent and a request timeout.
pub fn http_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(domain::user_agent())
        .timeout(timeout)
        .build()
}
