//! Domain types and rules for fat-horses (SPEC.md F2–F8). No I/O.

pub mod assign;
pub mod classify;
pub mod countries;
pub mod geo;
pub mod matching;
pub mod pick;
pub mod places;
pub mod pool;
pub mod race;
pub mod session;
pub mod status;
pub mod store;
pub mod winner;

/// Crate version, used in the CLI banner and the HTTP User-Agent.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Identifies the app to the services it calls, as their usage policies ask (N4).
pub fn user_agent() -> String {
    format!("fat-horses/{VERSION} (+https://github.com/Jade1724/fat-horses)")
}
