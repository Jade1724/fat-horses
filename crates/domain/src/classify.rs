//! Types for the LLM classifier (SPEC.md §3).

use serde::{Deserialize, Serialize};

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
