//! Deciding the winning country from a race result (SPEC.md F5).

use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};

use crate::assign::{CardEntry, RaceCard};
use crate::race::RaceStatus;

/// An interim result is accepted once unchanged for this long (F5.2).
pub const INTERIM_GRACE: Duration = Duration::minutes(10);
/// Give up waiting for a result this long after the scheduled start (F5.4).
pub const RESULT_TIMEOUT: Duration = Duration::minutes(45);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placing {
    pub position: u32,
    pub number: u32,
}

/// What the race source says about a race right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultSnapshot {
    pub status: RaceStatus,
    /// Empty until there is an interim or final result.
    pub placings: Vec<Placing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WinReason {
    Result,
    DeadHeat,
    Abandoned,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Winner {
    /// The winning runner. For `Abandoned`/`Timeout` it is the runner whose country
    /// was drawn at random.
    pub number: u32,
    pub country_iso: String,
    pub reason: WinReason,
    /// All runners tied for first (dead heat only).
    pub tied: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Pending,
    Winner(Winner),
}

/// Decide the winner, or `Pending` to poll again (F5.2–F5.4).
///
/// `interim_since` is when the current interim placings were first seen; the
/// caller resets it whenever the interim placings change.
pub fn resolve<R: Rng + ?Sized>(
    card: &RaceCard,
    snapshot: Option<&ResultSnapshot>,
    scheduled_start: DateTime<Utc>,
    now: DateTime<Utc>,
    interim_since: Option<DateTime<Utc>>,
    rng: &mut R,
) -> Decision {
    if let Some(s) = snapshot {
        match s.status {
            RaceStatus::Final => {
                if let Some(w) = from_placings(card, &s.placings, rng) {
                    return Decision::Winner(w);
                }
            }
            RaceStatus::Interim => {
                let settled = interim_since.is_some_and(|t| now - t >= INTERIM_GRACE);
                if settled && let Some(w) = from_placings(card, &s.placings, rng) {
                    return Decision::Winner(w);
                }
            }
            RaceStatus::Abandoned => return random_pick(card, WinReason::Abandoned, rng),
            RaceStatus::Open | RaceStatus::Closed => {}
        }
    }
    if now - scheduled_start >= RESULT_TIMEOUT {
        return random_pick(card, WinReason::Timeout, rng);
    }
    Decision::Pending
}

fn eligible(card: &RaceCard) -> impl Iterator<Item = &CardEntry> {
    card.entries
        .iter()
        .filter(|e| !e.scratched && e.country_iso.is_some())
}

/// The best-placed eligible runners; ties at that position are a dead heat.
fn from_placings<R: Rng + ?Sized>(
    card: &RaceCard,
    placings: &[Placing],
    rng: &mut R,
) -> Option<Winner> {
    let is_eligible = |n: u32| eligible(card).any(|e| e.number == n);
    let best = placings
        .iter()
        .filter(|p| is_eligible(p.number))
        .map(|p| p.position)
        .min()?;
    let mut tied: Vec<u32> = placings
        .iter()
        .filter(|p| p.position == best && is_eligible(p.number))
        .map(|p| p.number)
        .collect();
    tied.sort_unstable();
    tied.dedup();
    let number = *tied.choose(rng)?;
    let country_iso = card.entry(number)?.country_iso.clone()?;
    let dead_heat = tied.len() > 1;
    Some(Winner {
        number,
        country_iso,
        reason: if dead_heat {
            WinReason::DeadHeat
        } else {
            WinReason::Result
        },
        tied: if dead_heat { tied } else { Vec::new() },
    })
}

fn random_pick<R: Rng + ?Sized>(card: &RaceCard, reason: WinReason, rng: &mut R) -> Decision {
    let entries: Vec<&CardEntry> = eligible(card).collect();
    match entries.choose(rng) {
        Some(e) => Decision::Winner(Winner {
            number: e.number,
            country_iso: e.country_iso.clone().expect("eligible has a country"),
            reason,
            tied: Vec::new(),
        }),
        // Nothing left to choose from: every runner was scratched. Keep waiting;
        // the workflow's own timeout fails the pick.
        None => Decision::Pending,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rand::SeedableRng;
    use rand::rngs::StdRng;

    use super::*;

    fn start() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    fn at(minutes: i64) -> DateTime<Utc> {
        start() + Duration::minutes(minutes)
    }

    fn card() -> RaceCard {
        let entry = |number: u32, iso: &str, scratched: bool| CardEntry {
            number,
            horse: format!("Horse {number}"),
            country_iso: Some(iso.into()),
            scratched,
        };
        RaceCard {
            entries: vec![
                entry(1, "JP", false),
                entry(2, "IT", false),
                entry(3, "MX", true),
                entry(4, "IN", false),
            ],
        }
    }

    fn snap(status: RaceStatus, placings: &[(u32, u32)]) -> ResultSnapshot {
        ResultSnapshot {
            status,
            placings: placings
                .iter()
                .map(|&(position, number)| Placing { position, number })
                .collect(),
        }
    }

    fn rng() -> StdRng {
        StdRng::seed_from_u64(9)
    }

    fn winner(d: Decision) -> Winner {
        match d {
            Decision::Winner(w) => w,
            Decision::Pending => panic!("expected a winner"),
        }
    }

    #[test]
    fn official_result() {
        let s = snap(RaceStatus::Final, &[(1, 2), (2, 1), (3, 4)]);
        let w = winner(resolve(&card(), Some(&s), start(), at(3), None, &mut rng()));
        assert_eq!(w.number, 2);
        assert_eq!(w.country_iso, "IT");
        assert_eq!(w.reason, WinReason::Result);
        assert!(w.tied.is_empty());
    }

    #[test]
    fn interim_is_pending_before_ten_minutes() {
        let s = snap(RaceStatus::Interim, &[(1, 4)]);
        let d = resolve(&card(), Some(&s), start(), at(9), Some(at(1)), &mut rng());
        assert_eq!(d, Decision::Pending);
        let d = resolve(&card(), Some(&s), start(), at(9), None, &mut rng());
        assert_eq!(d, Decision::Pending);
    }

    #[test]
    fn interim_is_accepted_after_ten_minutes_unchanged() {
        let s = snap(RaceStatus::Interim, &[(1, 4)]);
        let w = winner(resolve(
            &card(),
            Some(&s),
            start(),
            at(11),
            Some(at(1)),
            &mut rng(),
        ));
        assert_eq!(w.number, 4);
        assert_eq!(w.country_iso, "IN");
    }

    #[test]
    fn dead_heat_picks_one_of_the_tied() {
        let s = snap(RaceStatus::Final, &[(1, 1), (1, 4), (3, 2)]);
        let mut seen = HashSet::new();
        for seed in 0..40 {
            let w = winner(resolve(
                &card(),
                Some(&s),
                start(),
                at(3),
                None,
                &mut StdRng::seed_from_u64(seed),
            ));
            assert_eq!(w.reason, WinReason::DeadHeat);
            assert_eq!(w.tied, [1, 4]);
            seen.insert(w.number);
        }
        assert_eq!(seen, HashSet::from([1, 4]));
    }

    #[test]
    fn abandoned_picks_an_active_country_at_random() {
        let s = snap(RaceStatus::Abandoned, &[]);
        let mut seen = HashSet::new();
        for seed in 0..60 {
            let w = winner(resolve(
                &card(),
                Some(&s),
                start(),
                at(1),
                None,
                &mut StdRng::seed_from_u64(seed),
            ));
            assert_eq!(w.reason, WinReason::Abandoned);
            assert_ne!(w.number, 3, "scratched runner chosen");
            seen.insert(w.country_iso);
        }
        assert_eq!(seen, HashSet::from(["JP".into(), "IT".into(), "IN".into()]));
    }

    #[test]
    fn times_out_45_minutes_after_start() {
        let open = snap(RaceStatus::Closed, &[]);
        assert_eq!(
            resolve(&card(), Some(&open), start(), at(44), None, &mut rng()),
            Decision::Pending
        );
        let w = winner(resolve(
            &card(),
            Some(&open),
            start(),
            at(45),
            None,
            &mut rng(),
        ));
        assert_eq!(w.reason, WinReason::Timeout);
        let w = winner(resolve(&card(), None, start(), at(50), None, &mut rng()));
        assert_eq!(w.reason, WinReason::Timeout);
    }

    #[test]
    fn a_final_result_beats_the_timeout() {
        let s = snap(RaceStatus::Final, &[(1, 1)]);
        let w = winner(resolve(
            &card(),
            Some(&s),
            start(),
            at(60),
            None,
            &mut rng(),
        ));
        assert_eq!(w.reason, WinReason::Result);
        assert_eq!(w.number, 1);
    }

    #[test]
    fn scratched_runner_cannot_win() {
        // Runner 3 is scratched on our card; the next best eligible runner wins.
        let s = snap(RaceStatus::Final, &[(1, 3), (2, 2), (3, 1)]);
        let w = winner(resolve(&card(), Some(&s), start(), at(3), None, &mut rng()));
        assert_eq!(w.number, 2);
        assert_eq!(w.reason, WinReason::Result);
    }

    #[test]
    fn runner_not_on_card_is_ignored() {
        let s = snap(RaceStatus::Final, &[(1, 99), (2, 4)]);
        let w = winner(resolve(&card(), Some(&s), start(), at(3), None, &mut rng()));
        assert_eq!(w.number, 4);
    }

    #[test]
    fn open_before_start_is_pending() {
        let s = snap(RaceStatus::Open, &[]);
        assert_eq!(
            resolve(&card(), Some(&s), start(), at(-1), None, &mut rng()),
            Decision::Pending
        );
    }
}
