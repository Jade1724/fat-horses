//! Restaurant status and visit tracking (SPEC.md F8).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::matching::MatchKind;

/// A stored restaurant's status. `None` in [`Restaurant::status`] is the spec's `null`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Picked,
    Visited,
}

/// A restaurant as stored once it has been picked or visited (§4.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Restaurant {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub address: Option<String>,
    pub cuisine: Vec<String>,
    /// The country a visit credits (F8.4).
    pub country_iso: String,
    pub status: Option<Status>,
    /// Status to restore on skip or supersede.
    pub status_before_pick: Option<Status>,
    pub picked_at: Option<DateTime<Utc>>,
    pub visited_at: Option<DateTime<Utc>>,
    pub visit_count: u32,
    pub pick_id: Option<String>,
    #[serde(rename = "match")]
    pub kind: Option<MatchKind>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A pick chose this restaurant.
    Pick { pick_id: String },
    /// "We went here", from a pick or straight from the map.
    Visit,
    /// "Skip".
    Skip,
    /// A newer pick chose a different restaurant while this one was still `PICKED`.
    Supersede,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogReason {
    Picked,
    Visited,
    Skipped,
    Superseded,
}

/// One history entry (F8.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub at: DateTime<Utc>,
    pub restaurant_id: String,
    pub restaurant_name: String,
    pub country_iso: String,
    pub from: Option<Status>,
    pub to: Option<Status>,
    pub reason: LogReason,
    pub pick_id: Option<String>,
}

/// Everything one transition changes, to be written atomically (F8.7).
#[derive(Debug, Clone, PartialEq)]
pub struct Transition {
    pub restaurant: Restaurant,
    /// The restaurant's status before the transition; stores make the write
    /// conditional on it.
    pub expected_status: Option<Status>,
    /// `true` when the country's `visit_count` goes up by one.
    pub country_visited: bool,
    pub log: LogEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("cannot {event} a restaurant whose status is {from:?}")]
pub struct InvalidTransition {
    pub event: &'static str,
    pub from: Option<Status>,
}

/// Apply `event` to `current` (F8.2). The caller is responsible for F8.3: before
/// picking a restaurant, supersede any other `PICKED` one in the same write.
pub fn apply(
    current: &Restaurant,
    event: Event,
    now: DateTime<Utc>,
) -> Result<Transition, InvalidTransition> {
    let from = current.status;
    let mut next = current.clone();
    let (reason, pick_id, country_visited) = match event {
        Event::Pick { pick_id } => {
            // Picking a restaurant that is already PICKED (the same place won again)
            // keeps its original status_before_pick.
            if from != Some(Status::Picked) {
                next.status_before_pick = from;
            }
            next.status = Some(Status::Picked);
            next.picked_at = Some(now);
            next.pick_id = Some(pick_id.clone());
            (LogReason::Picked, Some(pick_id), false)
        }
        Event::Visit => {
            next.status = Some(Status::Visited);
            next.status_before_pick = None;
            next.visited_at = Some(now);
            next.visit_count += 1;
            (LogReason::Visited, current.pick_id.clone(), true)
        }
        Event::Skip | Event::Supersede => {
            if from != Some(Status::Picked) {
                return Err(InvalidTransition {
                    event: if event == Event::Skip {
                        "skip"
                    } else {
                        "supersede"
                    },
                    from,
                });
            }
            next.status = current.status_before_pick;
            next.status_before_pick = None;
            let reason = if event == Event::Skip {
                LogReason::Skipped
            } else {
                LogReason::Superseded
            };
            (reason, current.pick_id.clone(), false)
        }
    };
    let log = LogEntry {
        at: now,
        restaurant_id: current.id.clone(),
        restaurant_name: current.name.clone(),
        country_iso: current.country_iso.clone(),
        from,
        to: next.status,
        reason,
        pick_id,
    };
    Ok(Transition {
        restaurant: next,
        expected_status: from,
        country_visited,
        log,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn now() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    pub fn restaurant(status: Option<Status>) -> Restaurant {
        Restaurant {
            id: "osm:node/1".into(),
            name: "Sakura".into(),
            lat: -36.85,
            lon: 174.76,
            address: None,
            cuisine: vec!["japanese".into()],
            country_iso: "JP".into(),
            status,
            status_before_pick: None,
            picked_at: None,
            visited_at: None,
            visit_count: u32::from(status == Some(Status::Visited)),
            pick_id: None,
            kind: Some(MatchKind::Tagged),
            reason: None,
        }
    }

    fn pick() -> Event {
        Event::Pick {
            pick_id: "p1".into(),
        }
    }

    #[test]
    fn null_to_picked() {
        let t = apply(&restaurant(None), pick(), now()).unwrap();
        assert_eq!(t.restaurant.status, Some(Status::Picked));
        assert_eq!(t.restaurant.status_before_pick, None);
        assert_eq!(t.restaurant.picked_at, Some(now()));
        assert_eq!(t.restaurant.pick_id.as_deref(), Some("p1"));
        assert_eq!(t.expected_status, None);
        assert!(!t.country_visited);
        assert_eq!(t.log.reason, LogReason::Picked);
        assert_eq!((t.log.from, t.log.to), (None, Some(Status::Picked)));
        assert_eq!(t.log.pick_id.as_deref(), Some("p1"));
    }

    #[test]
    fn visited_to_picked_remembers_visited() {
        let t = apply(&restaurant(Some(Status::Visited)), pick(), now()).unwrap();
        assert_eq!(t.restaurant.status, Some(Status::Picked));
        assert_eq!(t.restaurant.status_before_pick, Some(Status::Visited));
        assert_eq!(t.restaurant.visit_count, 1);
    }

    #[test]
    fn picked_again_keeps_status_before_pick() {
        let first = apply(&restaurant(Some(Status::Visited)), pick(), now()).unwrap();
        let again = apply(
            &first.restaurant,
            Event::Pick {
                pick_id: "p2".into(),
            },
            now(),
        )
        .unwrap();
        assert_eq!(again.restaurant.status_before_pick, Some(Status::Visited));
        assert_eq!(again.restaurant.pick_id.as_deref(), Some("p2"));
    }

    #[test]
    fn picked_to_visited() {
        let picked = apply(&restaurant(None), pick(), now()).unwrap().restaurant;
        let t = apply(&picked, Event::Visit, now()).unwrap();
        assert_eq!(t.restaurant.status, Some(Status::Visited));
        assert_eq!(t.restaurant.status_before_pick, None);
        assert_eq!(t.restaurant.visit_count, 1);
        assert_eq!(t.restaurant.visited_at, Some(now()));
        assert!(t.country_visited);
        assert_eq!(t.expected_status, Some(Status::Picked));
        assert_eq!(t.log.reason, LogReason::Visited);
        assert_eq!(t.log.pick_id.as_deref(), Some("p1"));
    }

    #[test]
    fn map_visit_from_null_and_from_visited() {
        let t = apply(&restaurant(None), Event::Visit, now()).unwrap();
        assert_eq!(t.restaurant.status, Some(Status::Visited));
        assert_eq!(t.restaurant.visit_count, 1);
        assert!(t.country_visited);

        let t = apply(&t.restaurant, Event::Visit, now()).unwrap();
        assert_eq!(t.restaurant.visit_count, 2);
        assert!(t.country_visited);
        assert_eq!(
            (t.log.from, t.log.to),
            (Some(Status::Visited), Some(Status::Visited))
        );
    }

    #[test]
    fn skip_restores_the_status_before_pick() {
        let picked = apply(&restaurant(None), pick(), now()).unwrap().restaurant;
        let t = apply(&picked, Event::Skip, now()).unwrap();
        assert_eq!(t.restaurant.status, None);
        assert_eq!(t.log.reason, LogReason::Skipped);
        assert!(!t.country_visited);

        let picked = apply(&restaurant(Some(Status::Visited)), pick(), now())
            .unwrap()
            .restaurant;
        let t = apply(&picked, Event::Skip, now()).unwrap();
        assert_eq!(t.restaurant.status, Some(Status::Visited));
        assert_eq!(t.restaurant.visit_count, 1);
    }

    #[test]
    fn supersede_restores_and_logs() {
        let picked = apply(&restaurant(None), pick(), now()).unwrap().restaurant;
        let t = apply(&picked, Event::Supersede, now()).unwrap();
        assert_eq!(t.restaurant.status, None);
        assert_eq!(t.log.reason, LogReason::Superseded);
        assert_eq!(t.log.from, Some(Status::Picked));
    }

    #[test]
    fn skip_or_supersede_need_picked() {
        for status in [None, Some(Status::Visited)] {
            assert_eq!(
                apply(&restaurant(status), Event::Skip, now()),
                Err(InvalidTransition {
                    event: "skip",
                    from: status
                })
            );
            assert_eq!(
                apply(&restaurant(status), Event::Supersede, now()),
                Err(InvalidTransition {
                    event: "supersede",
                    from: status
                })
            );
        }
    }

    #[test]
    fn status_serialises_in_caps() {
        assert_eq!(
            serde_json::to_string(&Status::Picked).unwrap(),
            "\"PICKED\""
        );
        assert_eq!(
            serde_json::to_string(&Status::Visited).unwrap(),
            "\"VISITED\""
        );
    }
}
