//! TAB NZ Affiliates API client (docs/spikes/tab-nz.md).

use std::collections::BTreeSet;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use domain::race::{
    MAX_LEAD, Race, RaceError, RaceProvider, RaceStatus, RaceType, RaceUpdate, Runner,
};
use domain::winner::Placing;
use serde::Deserialize;

pub const DEFAULT_BASE_URL: &str = "https://api.tab.co.nz/affiliates/v1";

/// Optional identifying headers the API docs ask for.
#[derive(Debug, Clone, Default)]
pub struct Identity {
    /// `From` header (an email address).
    pub from: Option<String>,
    /// `X-Partner` header.
    pub partner: Option<String>,
    /// `X-Partner-ID` header.
    pub partner_id: Option<String>,
}

impl Identity {
    /// Read `TAB_FROM`, `TAB_PARTNER` and `TAB_PARTNER_ID`.
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            from: var("TAB_FROM"),
            partner: var("TAB_PARTNER"),
            partner_id: var("TAB_PARTNER_ID"),
        }
    }
}

pub struct TabNz {
    http: reqwest::Client,
    base_url: String,
    identity: Identity,
}

impl TabNz {
    pub fn new(base_url: impl Into<String>, identity: Identity) -> reqwest::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(domain::user_agent())
            .timeout(StdDuration::from_secs(20))
            .build()?;
        Ok(Self {
            http,
            base_url: base_url.into(),
            identity,
        })
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<String, RaceError> {
        let mut req = self
            .http
            .get(format!("{}{path}", self.base_url))
            .query(query);
        for (name, value) in [
            ("From", &self.identity.from),
            ("X-Partner", &self.identity.partner),
            ("X-Partner-ID", &self.identity.partner_id),
        ] {
            if let Some(v) = value {
                req = req.header(name, v);
            }
        }
        let resp = req
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| RaceError::Unavailable(e.to_string()))?;
        resp.text()
            .await
            .map_err(|e| RaceError::Unavailable(e.to_string()))
    }
}

/// NZ race days covering `[now, now + MAX_LEAD]`. TAB dates meetings by NZ day
/// (UTC+12, or +13 in summer); both offsets are included so no zone database is needed.
pub fn race_days(now: DateTime<Utc>) -> Vec<NaiveDate> {
    let mut days = BTreeSet::new();
    for t in [now, now + MAX_LEAD] {
        for offset in [12, 13] {
            days.insert((t + Duration::hours(offset)).date_naive());
        }
    }
    days.into_iter().collect()
}

fn bad(what: &str, e: impl std::fmt::Display) -> RaceError {
    RaceError::Unavailable(format!("bad TAB NZ {what}: {e}"))
}

fn race_type(category: &str) -> Option<RaceType> {
    match category {
        "T" => Some(RaceType::Gallops),
        "H" => Some(RaceType::Harness),
        "G" => Some(RaceType::Greyhound),
        _ => None,
    }
}

fn race_status(s: &str) -> Option<RaceStatus> {
    match s {
        "Open" => Some(RaceStatus::Open),
        "Closed" => Some(RaceStatus::Closed),
        "Interim" => Some(RaceStatus::Interim),
        "Final" => Some(RaceStatus::Final),
        "Abandoned" => Some(RaceStatus::Abandoned),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct Header {
    error: Option<String>,
    error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeetingsResponse {
    header: Header,
    data: Option<MeetingsData>,
}

#[derive(Debug, Deserialize)]
struct MeetingsData {
    #[serde(default)]
    meetings: Vec<Meeting>,
}

#[derive(Debug, Deserialize)]
struct Meeting {
    meeting: String,
    name: String,
    category: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    races: Vec<MeetingRace>,
}

#[derive(Debug, Deserialize)]
struct MeetingRace {
    id: String,
    race_number: u32,
    #[serde(default)]
    name: String,
    start_time: DateTime<Utc>,
    status: String,
}

/// Parse a `/racing/meetings` or `/racing/meetings/{id}` response into races
/// (without runners). Meetings or races of unknown type/status are skipped.
pub fn parse_meetings(body: &str) -> Result<Vec<Race>, RaceError> {
    let resp: MeetingsResponse = serde_json::from_str(body).map_err(|e| bad("meetings", e))?;
    if let Some(err) = resp.header.error {
        return Err(RaceError::Unavailable(format!("TAB NZ: {err}")));
    }
    let meetings = resp.data.map(|d| d.meetings).unwrap_or_default();
    Ok(meetings
        .into_iter()
        .filter_map(|m| race_type(&m.category).map(|t| (m, t)))
        .flat_map(|(m, t)| {
            let Meeting {
                meeting,
                name,
                country,
                races,
                ..
            } = m;
            races.into_iter().filter_map(move |r| {
                Some(Race {
                    status: race_status(&r.status)?,
                    id: r.id,
                    meeting_id: meeting.clone(),
                    venue: name.clone(),
                    venue_country: country.clone(),
                    race_number: r.race_number,
                    name: r.name,
                    race_type: t,
                    start_time: r.start_time,
                    runners: Vec::new(),
                })
            })
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct EventResponse {
    header: Header,
    data: Option<EventData>,
}

#[derive(Debug, Deserialize)]
struct EventData {
    race: EventRace,
    #[serde(default)]
    runners: Vec<EventRunner>,
    #[serde(default)]
    results: Option<Vec<EventResult>>,
}

#[derive(Debug, Deserialize)]
struct EventRace {
    status: String,
    advertised_start: i64,
}

#[derive(Debug, Deserialize)]
struct EventRunner {
    runner_number: u32,
    name: String,
    #[serde(default)]
    is_scratched: bool,
}

#[derive(Debug, Deserialize)]
struct EventResult {
    position: u32,
    runner_number: u32,
}

/// What an event lookup returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Found(RaceUpdate),
    /// `FR0002 race can not be found`: seen for abandoned races.
    NotFound,
}

/// Parse `/racing/events/{id}`, applying it to the scheduled `race`.
pub fn parse_event(body: &str, race: &Race) -> Result<Event, RaceError> {
    let resp: EventResponse = serde_json::from_str(body).map_err(|e| bad("event", e))?;
    if resp.header.error_code.as_deref() == Some("FR0002") {
        return Ok(Event::NotFound);
    }
    if let Some(err) = resp.header.error {
        return Err(RaceError::Unavailable(format!("TAB NZ: {err}")));
    }
    let data = resp
        .data
        .ok_or_else(|| bad("event", "no data and no error"))?;
    let status =
        race_status(&data.race.status).ok_or_else(|| bad("event status", &data.race.status))?;
    let start_time = Utc
        .timestamp_opt(data.race.advertised_start, 0)
        .single()
        .unwrap_or(race.start_time);
    let mut runners: Vec<Runner> = data
        .runners
        .into_iter()
        .map(|r| Runner {
            number: r.runner_number,
            name: r.name,
            scratched: r.is_scratched,
        })
        .collect();
    runners.sort_by_key(|r| r.number);
    let placings = data
        .results
        .unwrap_or_default()
        .into_iter()
        .map(|r| Placing {
            position: r.position,
            number: r.runner_number,
        })
        .collect();
    Ok(Event::Found(RaceUpdate {
        race: Race {
            status,
            start_time,
            runners,
            ..race.clone()
        },
        placings,
    }))
}

impl RaceProvider for TabNz {
    async fn schedule(&self, now: DateTime<Utc>) -> Result<Vec<Race>, RaceError> {
        let mut races = Vec::new();
        for day in race_days(now) {
            let d = day.format("%Y-%m-%d").to_string();
            let body = self
                .get(
                    "/racing/meetings",
                    &[("date_from", d.clone()), ("date_to", d)],
                )
                .await?;
            races.extend(parse_meetings(&body)?);
        }
        races.sort_by(|a, b| a.id.cmp(&b.id));
        races.dedup_by(|a, b| a.id == b.id);
        Ok(races)
    }

    async fn update(&self, race: &Race) -> Result<RaceUpdate, RaceError> {
        let body = self
            .get(&format!("/racing/events/{}", race.id), &[])
            .await?;
        match parse_event(&body, race)? {
            Event::Found(update) => Ok(update),
            Event::NotFound => {
                // Abandoned races disappear from the event endpoint; the meeting still lists them.
                let body = self
                    .get(&format!("/racing/meetings/{}", race.meeting_id), &[])
                    .await?;
                let status = parse_meetings(&body)?
                    .into_iter()
                    .find(|r| r.id == race.id)
                    .map(|r| r.status)
                    .ok_or_else(|| bad("event", format!("race {} not found", race.id)))?;
                Ok(RaceUpdate {
                    race: Race {
                        status,
                        ..race.clone()
                    },
                    placings: Vec::new(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../tests/fixtures/tab_nz/", $name))
        };
    }

    fn scottsville() -> Race {
        parse_meetings(fixture!("meeting_open.json"))
            .unwrap()
            .into_iter()
            .find(|r| r.id == "f0eb3cef-e900-48bd-be5c-fe7b0330239f")
            .unwrap()
    }

    fn found(e: Event) -> RaceUpdate {
        match e {
            Event::Found(u) => u,
            Event::NotFound => panic!("expected an event"),
        }
    }

    #[test]
    fn race_days_cover_both_nz_offsets_and_three_hours() {
        let days = |t: &str| {
            race_days(t.parse().unwrap())
                .iter()
                .map(|d| d.to_string())
                .collect::<Vec<_>>()
        };
        // 09:57 UTC is 21:57/22:57 NZ; three hours later is past NZ midnight.
        assert_eq!(days("2026-09-21T09:57:00Z"), ["2026-09-21", "2026-09-22"]);
        assert_eq!(days("2026-09-21T02:00:00Z"), ["2026-09-21"]);
    }

    #[test]
    fn meetings_list_maps_types_and_statuses() {
        let races = parse_meetings(fixture!("meetings_list.json")).unwrap();
        assert!(!races.is_empty());
        let laurel: Vec<&Race> = races.iter().filter(|r| r.venue == "Laurel Park").collect();
        assert_eq!(laurel.len(), 10);
        assert!(laurel.iter().all(|r| r.race_type == RaceType::Gallops));
        assert_eq!(laurel[0].venue_country, "USA");
        assert!(
            races
                .iter()
                .filter(|r| r.venue == "Orkla")
                .all(|r| r.race_type == RaceType::Harness)
        );
        assert!(
            races
                .iter()
                .filter(|r| r.venue == "Shepparton")
                .all(|r| r.race_type == RaceType::Greyhound)
        );
        assert!(races.iter().any(|r| r.status == RaceStatus::Open));
        assert!(races.iter().any(|r| r.status == RaceStatus::Final));
        assert!(races.iter().all(|r| r.runners.is_empty()));
    }

    #[test]
    fn open_race_card_with_scratchings() {
        let u = found(parse_event(fixture!("event_open_scratched.json"), &scottsville()).unwrap());
        assert_eq!(u.race.status, RaceStatus::Open);
        assert_eq!(u.race.runners.len(), 18);
        let scratched: Vec<u32> = u
            .race
            .runners
            .iter()
            .filter(|r| r.scratched)
            .map(|r| r.number)
            .collect();
        assert_eq!(scratched, [2, 18]);
        assert!(u.race.has_enough_runners());
        assert!(u.placings.is_empty());
        assert_eq!(u.race.start_time, scottsville().start_time);
    }

    #[test]
    fn closed_interim_and_final() {
        let race = scottsville();
        let closed = found(parse_event(fixture!("event_closed.json"), &race).unwrap());
        assert_eq!(closed.race.status, RaceStatus::Closed);
        assert!(closed.placings.is_empty());

        let interim = found(parse_event(fixture!("event_interim.json"), &race).unwrap());
        assert_eq!(interim.race.status, RaceStatus::Interim);
        assert_eq!(
            interim.placings,
            [Placing {
                position: 1,
                number: 5
            }]
        );

        let fin = found(parse_event(fixture!("event_final.json"), &race).unwrap());
        assert_eq!(fin.race.status, RaceStatus::Final);
        assert_eq!(fin.placings[0].number, 5);
        assert!(fin.placings.len() >= 4);
        assert_eq!(fin.snapshot().status, RaceStatus::Final);
    }

    #[test]
    fn dead_heat_has_two_winners() {
        let u =
            found(parse_event(fixture!("event_dead_heat_synthetic.json"), &scottsville()).unwrap());
        assert_eq!(u.placings.iter().filter(|p| p.position == 1).count(), 2);
    }

    #[test]
    fn abandoned_event_is_not_found_and_meeting_says_abandoned() {
        let race = scottsville();
        assert_eq!(
            parse_event(fixture!("event_not_found.json"), &race).unwrap(),
            Event::NotFound
        );
        let gore = parse_meetings(fixture!("meeting_abandoned.json")).unwrap();
        assert!(!gore.is_empty());
        assert!(gore.iter().all(|r| r.status == RaceStatus::Abandoned));
        assert_eq!(gore[0].venue, "Gore");
    }

    #[test]
    fn other_errors_are_errors() {
        let body = r#"{"header":{"error":"There was an unexpected error","error_code":"FR1000"}}"#;
        assert!(parse_meetings(body).is_err());
        assert!(parse_event(body, &scottsville()).is_err());
        assert!(parse_event("<html>", &scottsville()).is_err());
    }
}
