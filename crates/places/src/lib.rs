//! Nominatim geocoder and Overpass places client (SPEC.md F1.2, F6.1).

pub mod nominatim;

use std::time::Duration;

/// Identifies the app to OSM services, as their usage policies require (N4).
pub fn user_agent() -> String {
    format!(
        "fat-horses/{} (+https://github.com/Jade1724/fat-horses)",
        domain::VERSION
    )
}

/// An HTTP client with the app's User-Agent and a request timeout.
pub fn http_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .timeout(timeout)
        .build()
}
