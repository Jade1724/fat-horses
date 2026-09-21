//! Plain-text output for the CLI.

use std::fmt::Write;

use domain::countries::CountriesFile;
use domain::matching::MatchKind;
use domain::session::{PickSession, PickStatus};
use domain::status::{LogReason, Restaurant, Status};
use domain::store::{CountryVisits, HistoryPage};
use domain::winner::WinReason;

fn country_label(countries: &CountriesFile, iso2: &str) -> String {
    match countries.get(iso2) {
        Some(c) => format!("{} {}", c.flag, c.name),
        None => iso2.to_string(),
    }
}

/// The race card (F4.3).
pub fn race_card(s: &PickSession, countries: &CountriesFile) -> String {
    let mut out = String::new();
    let (Some(race), Some(card)) = (&s.race, &s.card) else {
        return out;
    };
    let _ = writeln!(
        out,
        "🏇 {} R{} — {} ({}), starts {} UTC",
        race.venue,
        race.race_number,
        race.name,
        race.venue_country,
        race.start_time.format("%H:%M")
    );
    for e in &card.entries {
        let who = match &e.country_iso {
            Some(iso) => country_label(countries, iso),
            None => "—".into(),
        };
        let scratched = if e.scratched { "  (scratched)" } else { "" };
        let _ = writeln!(out, "  {:>2}  {:<24} {who}{scratched}", e.number, e.horse);
    }
    if s.world_complete {
        let _ = writeln!(out, "🌍 World complete! Every country is back in the draw.");
    }
    out
}

/// The final result: winner, matches and the pick (F10.5 in text).
pub fn summary(s: &PickSession, countries: &CountriesFile) -> String {
    let mut out = String::new();
    if s.status == PickStatus::Failed {
        let _ = writeln!(out, "❌ Pick failed: {:?}", s.error);
        return out;
    }
    let Some(w) = &s.winner else {
        return out;
    };
    let how = match w.reason {
        WinReason::Result => String::new(),
        WinReason::DeadHeat => format!(" (dead heat between {:?}, drawn at random)", w.tied),
        WinReason::Abandoned => " (race abandoned — random pick)".into(),
        WinReason::Timeout => " (no result in time — random pick)".into(),
    };
    let _ = writeln!(
        out,
        "🏆 Horse {} wins: {}{how}",
        w.number,
        country_label(countries, &w.country_iso)
    );
    if s.llm_unavailable {
        let _ = writeln!(
            out,
            "⚠️  Cuisine guessing unavailable, showing tagged places only"
        );
    }
    if s.matches.is_empty() {
        let _ = writeln!(out, "No match nearby.");
        if let Some(c) = countries.get(&w.country_iso) {
            let _ = writeln!(out, "Try looking for: {}", c.dishes.join(", "));
        }
        return out;
    }
    let _ = writeln!(out, "{} match(es) nearby:", s.matches.len());
    for m in &s.matches {
        let Some(p) = s.places.iter().find(|p| p.id == m.place_id) else {
            continue;
        };
        let star = if s.pick.as_deref() == Some(p.id.as_str()) {
            "👉"
        } else {
            "  "
        };
        let kind = match m.kind {
            MatchKind::Tagged => String::new(),
            MatchKind::Inferred | MatchKind::Fallback => format!(
                "  [likely: {}]",
                m.reason.as_deref().unwrap_or("no reason given")
            ),
        };
        let _ = writeln!(
            out,
            "{star} {} — {:.0} m{}{kind}",
            p.name,
            p.distance_m,
            p.address
                .as_deref()
                .map(|a| format!(", {a}"))
                .unwrap_or_default()
        );
    }
    if let Some(p) = s
        .pick
        .as_ref()
        .and_then(|id| s.places.iter().find(|p| &p.id == id))
    {
        let _ = writeln!(
            out,
            "Directions: https://www.google.com/maps/dir/?api=1&destination={},{}",
            p.lat, p.lon
        );
        let _ = writeln!(
            out,
            "After eating there: fat-horses visit '{}'   (or: fat-horses skip '{}')",
            p.id, p.id
        );
    }
    out
}

fn status_label(s: Option<Status>) -> &'static str {
    match s {
        None => "not picked",
        Some(Status::Picked) => "PICKED",
        Some(Status::Visited) => "VISITED",
    }
}

/// One restaurant after a visit or skip.
pub fn restaurant(r: &Restaurant, countries: &CountriesFile) -> String {
    format!(
        "{} ({}): {}, {} visit(s)\n",
        r.name,
        country_label(countries, &r.country_iso),
        status_label(r.status),
        r.visit_count
    )
}

/// The Passport (F9.1): every pool country, visited first.
pub fn passport(
    countries: &CountriesFile,
    visits: &[CountryVisits],
    min_population: u64,
) -> String {
    let mut rows: Vec<(bool, String)> = countries
        .countries
        .iter()
        .filter(|c| c.population >= min_population)
        .map(|c| {
            let v = visits
                .iter()
                .find(|v| v.iso2 == c.iso2 && v.visit_count > 0);
            let line = match v {
                Some(v) => format!(
                    "  ✅ {} {} — {} visit(s), last {}",
                    c.flag,
                    c.name,
                    v.visit_count,
                    v.last_visited_at
                        .map(|t| t.format("%Y-%m-%d").to_string())
                        .unwrap_or_default()
                ),
                None => format!("  ·  {} {}", c.flag, c.name),
            };
            (v.is_some(), line)
        })
        .collect();
    let total = rows.len();
    let visited = rows.iter().filter(|(v, _)| *v).count();
    rows.sort_by_key(|(v, _)| !*v);
    let mut out = format!("Passport: visited {visited} of {total} countries\n");
    for (_, line) in rows {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// One page of history (F9.2), newest first.
pub fn history(page: &HistoryPage, countries: &CountriesFile) -> String {
    if page.entries.is_empty() {
        return "No history yet.\n".into();
    }
    let mut out = String::new();
    for e in &page.entries {
        let what = match e.reason {
            LogReason::Picked => "picked",
            LogReason::Visited => "visited",
            LogReason::Skipped => "skipped",
            LogReason::Superseded => "replaced by a newer pick",
        };
        let _ = writeln!(
            out,
            "{}  {:<24} {:<26} {what}",
            e.at.format("%Y-%m-%d %H:%M"),
            e.restaurant_name,
            country_label(countries, &e.country_iso),
        );
    }
    if let Some(c) = &page.next_cursor {
        let _ = writeln!(out, "More: fat-horses history --cursor '{c}'");
    }
    out
}

/// Prints progress as the session changes.
#[derive(Default)]
pub struct Printer {
    last: Option<PickStatus>,
    card_shown: bool,
}

impl Printer {
    pub fn update(&mut self, s: &PickSession, countries: &CountriesFile) {
        if !self.card_shown && s.card.is_some() {
            print!("{}", race_card(s, countries));
            self.card_shown = true;
        }
        if self.last != Some(s.status) {
            let msg = match s.status {
                PickStatus::FindingRace => "Finding the next race…",
                PickStatus::WaitingStart => "Waiting for the start…",
                PickStatus::Running => "Race under way, waiting for the result…",
                PickStatus::Resolving => "Result in!",
                PickStatus::Searching => "Looking for restaurants…",
                PickStatus::Done | PickStatus::Failed => "",
            };
            if !msg.is_empty() {
                println!("⏳ {msg}");
            }
            self.last = Some(s.status);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use domain::assign::{CardEntry, RaceCard};
    use domain::geo::Location;
    use domain::matching::Match;
    use domain::places::Place;
    use domain::race::{Race, RaceStatus, RaceType};
    use domain::session::{PickError, PickRequest};
    use domain::winner::Winner;

    use super::*;

    fn session() -> PickSession {
        let mut s = PickSession::new(
            "p1".into(),
            "2026-09-21T10:00:00Z".parse().unwrap(),
            PickRequest {
                radius_m: 200,
                min_population: 10_000_000,
                include_visited: false,
            },
            Location {
                lat: -36.85,
                lon: 174.76,
                display_name: "Sky Tower".into(),
            },
        );
        s.race = Some(Race {
            id: "r".into(),
            meeting_id: "m".into(),
            venue: "Ellerslie".into(),
            venue_country: "NZ".into(),
            race_number: 3,
            name: "Test Stakes".into(),
            race_type: RaceType::Gallops,
            status: RaceStatus::Open,
            start_time: "2026-09-21T10:08:00Z".parse().unwrap(),
            runners: vec![],
        });
        s.card = Some(RaceCard {
            entries: vec![
                CardEntry {
                    number: 1,
                    horse: "Fast One".into(),
                    country_iso: Some("JP".into()),
                    scratched: false,
                },
                CardEntry {
                    number: 2,
                    horse: "Slow One".into(),
                    country_iso: None,
                    scratched: true,
                },
            ],
        });
        s
    }

    #[test]
    fn card_lists_runners_and_countries() {
        let text = race_card(&session(), &CountriesFile::bundled());
        assert!(text.contains("Ellerslie R3"), "{text}");
        assert!(text.contains("10:08 UTC"));
        assert!(text.contains("Fast One"));
        assert!(text.contains("🇯🇵 Japan"));
        assert!(text.contains("(scratched)"));
    }

    #[test]
    fn summary_shows_pick_and_directions() {
        let mut s = session();
        s.status = PickStatus::Done;
        s.winner = Some(Winner {
            number: 1,
            country_iso: "JP".into(),
            reason: WinReason::Result,
            tied: vec![],
        });
        s.places = vec![Place {
            id: "osm:node/1".into(),
            name: "Sakura".into(),
            lat: -36.8,
            lon: 174.7,
            address: Some("1 Queen St".into()),
            amenity: "restaurant".into(),
            cuisine: vec!["sushi".into()],
            tags: BTreeMap::new(),
            distance_m: 120.0,
        }];
        s.matches = vec![Match {
            place_id: "osm:node/1".into(),
            kind: MatchKind::Tagged,
            reason: None,
        }];
        s.pick = Some("osm:node/1".into());
        let text = summary(&s, &CountriesFile::bundled());
        assert!(text.contains("Horse 1 wins: 🇯🇵 Japan"), "{text}");
        assert!(text.contains("👉 Sakura — 120 m, 1 Queen St"));
        assert!(text.contains("destination=-36.8,174.7"));
        assert!(text.contains("fat-horses visit 'osm:node/1'"));
    }

    #[test]
    fn summary_without_matches_lists_dishes() {
        let mut s = session();
        s.status = PickStatus::Done;
        s.winner = Some(Winner {
            number: 1,
            country_iso: "JP".into(),
            reason: WinReason::Abandoned,
            tied: vec![],
        });
        let text = summary(&s, &CountriesFile::bundled());
        assert!(text.contains("race abandoned"), "{text}");
        assert!(text.contains("No match nearby."));
        assert!(text.contains("sushi"));
    }

    #[tokio::test]
    async fn passport_and_history_from_a_store() {
        use domain::store::{VisitStore, record_pick, record_visit};
        let store = store::MemoryStore::new();
        let t = |m: i64| {
            "2026-09-21T10:00:00Z"
                .parse::<chrono::DateTime<chrono::Utc>>()
                .unwrap()
                + chrono::Duration::minutes(m)
        };
        let mut r = store::contract::restaurant("osm:node/1", "JP");
        r.name = "Sakura".into();
        record_pick(&store, r, "p1", t(0)).await.unwrap();
        let visited = record_visit(&store, "osm:node/1", None, t(30))
            .await
            .unwrap();
        let countries = CountriesFile::bundled();

        let text = restaurant(&visited, &countries);
        assert_eq!(text, "Sakura (🇯🇵 Japan): VISITED, 1 visit(s)\n");

        let visits = store.country_visits().await.unwrap();
        let text = passport(&countries, &visits, 10_000_000);
        assert!(
            text.starts_with("Passport: visited 1 of 95 countries\n"),
            "{text}"
        );
        let second_line = text.lines().nth(1).unwrap();
        assert_eq!(second_line, "  ✅ 🇯🇵 Japan — 1 visit(s), last 2026-09-21");
        assert!(text.contains("  ·  🇮🇹 Italy"));

        let page = store.history(None, 1).await.unwrap();
        let text = history(&page, &countries);
        assert!(text.starts_with("2026-09-21 10:30  Sakura"), "{text}");
        assert!(text.contains("visited"));
        assert!(text.contains("More: fat-horses history --cursor"));
        let rest = store.history(page.next_cursor, 10).await.unwrap();
        assert!(history(&rest, &countries).contains("picked"));
        assert_eq!(
            history(
                &HistoryPage {
                    entries: vec![],
                    next_cursor: None
                },
                &countries
            ),
            "No history yet.\n"
        );
    }

    #[test]
    fn failed_summary() {
        let mut s = session();
        s.fail(PickError::NoUpcomingRace);
        assert!(summary(&s, &CountriesFile::bundled()).contains("NoUpcomingRace"));
    }
}
