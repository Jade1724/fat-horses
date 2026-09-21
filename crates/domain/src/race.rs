//! Races and race selection (SPEC.md F3).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// A race must start at least this long after `now` to be chosen (F3.2).
pub const MIN_LEAD: Duration = Duration::minutes(2);
/// Races starting later than this after `now` are not considered (F3.2).
pub const MAX_LEAD: Duration = Duration::hours(3);
/// A race needs at least this many non-scratched runners (F3.3).
pub const MIN_RUNNERS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RaceType {
    Gallops,
    Harness,
    Greyhound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RaceStatus {
    /// Betting open; not started.
    Open,
    /// Started or betting closed; no result yet.
    Closed,
    /// Provisional result.
    Interim,
    /// Official result.
    Final,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Runner {
    pub number: u32,
    pub name: String,
    pub scratched: bool,
}

/// A race as listed by the race source. `runners` is empty when only the
/// schedule is known (details not fetched yet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Race {
    pub id: String,
    pub meeting_id: String,
    pub venue: String,
    /// Country of the venue, as given by the source (e.g. "AUS", "NZ").
    pub venue_country: String,
    pub race_number: u32,
    pub name: String,
    pub race_type: RaceType,
    pub status: RaceStatus,
    pub start_time: DateTime<Utc>,
    pub runners: Vec<Runner>,
}

impl Race {
    pub fn active_runners(&self) -> impl Iterator<Item = &Runner> {
        self.runners.iter().filter(|r| !r.scratched)
    }

    /// Enough non-scratched runners to race for a country (F3.3).
    pub fn has_enough_runners(&self) -> bool {
        self.active_runners().count() >= MIN_RUNNERS
    }
}

/// Races that may be chosen, in the order to try them (F3.1–F3.3, schedule
/// part): open gallops races starting in `[now + 2 min, now + 3 h]`, earliest
/// first. The caller fetches runners for each in turn and takes the first with
/// [`Race::has_enough_runners`]. Earliest-after-2-minutes covers both halves of
/// F3.2: if a race starts within 15 minutes it is necessarily the earliest.
pub fn candidates(races: &[Race], now: DateTime<Utc>) -> Vec<&Race> {
    let mut out: Vec<&Race> = races
        .iter()
        .filter(|r| r.race_type == RaceType::Gallops)
        .filter(|r| r.status == RaceStatus::Open)
        .filter(|r| r.start_time >= now + MIN_LEAD && r.start_time <= now + MAX_LEAD)
        .collect();
    out.sort_by(|a, b| {
        a.start_time
            .cmp(&b.start_time)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// The race to use when runners are already known for every race (F3).
pub fn select_race(races: &[Race], now: DateTime<Utc>) -> Option<&Race> {
    candidates(races, now)
        .into_iter()
        .find(|r| r.has_enough_runners())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn now() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    pub fn runner(number: u32, scratched: bool) -> Runner {
        Runner {
            number,
            name: format!("Horse {number}"),
            scratched,
        }
    }

    pub fn race(id: &str, minutes_from_now: i64) -> Race {
        Race {
            id: id.into(),
            meeting_id: "m1".into(),
            venue: "Ellerslie".into(),
            venue_country: "NZ".into(),
            race_number: 1,
            name: "Race 1".into(),
            race_type: RaceType::Gallops,
            status: RaceStatus::Open,
            start_time: now() + Duration::minutes(minutes_from_now),
            runners: (1..=8).map(|n| runner(n, false)).collect(),
        }
    }

    fn ids(races: Vec<&Race>) -> Vec<&str> {
        races.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn picks_earliest_in_the_2_to_15_minute_window() {
        let races = [race("late", 14), race("soon", 5), race("too_soon", 1)];
        assert_eq!(select_race(&races, now()).unwrap().id, "soon");
    }

    #[test]
    fn exactly_two_minutes_is_allowed() {
        let races = [race("r", 2)];
        assert_eq!(select_race(&races, now()).unwrap().id, "r");
    }

    #[test]
    fn falls_back_to_next_race_after_the_window() {
        let races = [race("later", 90), race("next", 40), race("gone", -5)];
        assert_eq!(select_race(&races, now()).unwrap().id, "next");
    }

    #[test]
    fn nothing_within_three_hours_is_none() {
        let races = [race("tomorrow", 181)];
        assert!(select_race(&races, now()).is_none());
        let races = [race("edge", 180)];
        assert_eq!(select_race(&races, now()).unwrap().id, "edge");
    }

    #[test]
    fn only_gallops() {
        let mut harness = race("harness", 5);
        harness.race_type = RaceType::Harness;
        let mut dogs = race("dogs", 6);
        dogs.race_type = RaceType::Greyhound;
        let races = [harness, dogs, race("gallops", 7)];
        assert_eq!(ids(candidates(&races, now())), ["gallops"]);
    }

    #[test]
    fn only_open_races() {
        let mut races = Vec::new();
        for (i, status) in [
            RaceStatus::Closed,
            RaceStatus::Interim,
            RaceStatus::Final,
            RaceStatus::Abandoned,
        ]
        .into_iter()
        .enumerate()
        {
            let mut r = race(&format!("{status:?}"), 5 + i as i64);
            r.status = status;
            races.push(r);
        }
        races.push(race("open", 20));
        assert_eq!(ids(candidates(&races, now())), ["open"]);
    }

    #[test]
    fn needs_two_active_runners() {
        let mut thin = race("thin", 5);
        thin.runners = vec![runner(1, false), runner(2, true), runner(3, true)];
        let races = [thin, race("full", 8)];
        assert_eq!(select_race(&races, now()).unwrap().id, "full");

        let mut two = race("two", 5);
        two.runners = vec![runner(1, false), runner(2, false), runner(3, true)];
        assert!(two.has_enough_runners());
    }

    #[test]
    fn candidates_are_ordered_by_start_time() {
        let races = [race("c", 30), race("a", 3), race("b", 10)];
        assert_eq!(ids(candidates(&races, now())), ["a", "b", "c"]);
    }

    #[test]
    fn empty_list_is_none() {
        assert!(select_race(&[], now()).is_none());
    }
}
