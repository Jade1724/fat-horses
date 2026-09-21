//! The pick session: everything one pick knows, stored as it progresses (SPEC.md §4.2, §5, §6).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::assign::RaceCard;
use crate::classify::Guess;
use crate::geo::Location;
use crate::matching::Match;
use crate::places::Place;
use crate::race::Race;
use crate::winner::{Placing, Winner};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickStatus {
    FindingRace,
    WaitingStart,
    Running,
    Resolving,
    Searching,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickError {
    NoUpcomingRace,
    RaceSourceUnavailable,
    PlacesUnavailable,
    Internal,
}

/// The validated request that started a pick (F1.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PickRequest {
    pub radius_m: u32,
    pub min_population: u64,
    pub include_visited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PickSession {
    pub pick_id: String,
    pub created_at: DateTime<Utc>,
    pub request: PickRequest,
    pub location: Location,
    pub status: PickStatus,
    pub error: Option<PickError>,
    pub world_complete: bool,
    /// The chosen race; its `runners` hold the latest scratchings.
    pub race: Option<Race>,
    pub card: Option<RaceCard>,
    /// The latest interim placings and when they were first seen unchanged (F5.2).
    pub interim_placings: Vec<Placing>,
    pub interim_since: Option<DateTime<Utc>>,
    pub winner: Option<Winner>,
    pub places: Vec<Place>,
    pub guesses: Vec<Guess>,
    pub matches: Vec<Match>,
    /// Place id of the chosen restaurant.
    pub pick: Option<String>,
    pub llm_unavailable: bool,
}

impl PickSession {
    pub fn new(
        pick_id: String,
        created_at: DateTime<Utc>,
        request: PickRequest,
        location: Location,
    ) -> Self {
        Self {
            pick_id,
            created_at,
            request,
            location,
            status: PickStatus::FindingRace,
            error: None,
            world_complete: false,
            race: None,
            card: None,
            interim_placings: Vec::new(),
            interim_since: None,
            winner: None,
            places: Vec::new(),
            guesses: Vec::new(),
            matches: Vec::new(),
            pick: None,
            llm_unavailable: false,
        }
    }

    pub fn fail(&mut self, error: PickError) {
        self.status = PickStatus::Failed;
        self.error = Some(error);
    }
}
