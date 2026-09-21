//! Domain types and rules for fat-horses (SPEC.md F2–F8). No I/O.

pub mod assign;
pub mod classify;
pub mod countries;
pub mod matching;
pub mod pick;
pub mod places;
pub mod pool;
pub mod race;
pub mod status;
pub mod winner;

/// Crate version, used in the CLI banner and the HTTP User-Agent.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
