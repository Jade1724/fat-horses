//! Assigning countries to horses (SPEC.md F4).

use rand::Rng;
use rand::seq::{IndexedRandom, SliceRandom};
use serde::{Deserialize, Serialize};

use crate::countries::Country;
use crate::pool::Pool;
use crate::race::Runner;

/// One line of the race card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardEntry {
    pub number: u32,
    pub horse: String,
    /// `None` only for runners already scratched at assignment time.
    pub country_iso: Option<String>,
    pub scratched: bool,
}

/// The saved assignment of countries to runners (F4.3). Never re-drawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RaceCard {
    pub entries: Vec<CardEntry>,
}

impl RaceCard {
    pub fn entry(&self, number: u32) -> Option<&CardEntry> {
        self.entries.iter().find(|e| e.number == number)
    }

    /// Mark runners scratched after assignment (F4.4). Their countries stay on the
    /// card for display but can no longer win.
    pub fn apply_scratchings(&mut self, runners: &[Runner]) {
        for r in runners.iter().filter(|r| r.scratched) {
            if let Some(e) = self.entries.iter_mut().find(|e| e.number == r.number) {
                e.scratched = true;
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AssignError {
    #[error("the country pool is empty")]
    EmptyPool,
}

/// Draw countries for the non-scratched runners (F4.1–F4.2):
/// distinct countries from `pool.countries` first, then distinct unused ones from
/// `pool.full`, and only then repeats.
pub fn assign<R: Rng + ?Sized>(
    runners: &[Runner],
    pool: &Pool<'_>,
    rng: &mut R,
) -> Result<RaceCard, AssignError> {
    let needed = runners.iter().filter(|r| !r.scratched).count();
    let drawn = draw(needed, pool, rng)?;
    let mut drawn = drawn.into_iter();
    let entries = runners
        .iter()
        .map(|r| CardEntry {
            number: r.number,
            horse: r.name.clone(),
            country_iso: if r.scratched {
                None
            } else {
                drawn.next().map(|c| c.iso2.clone())
            },
            scratched: r.scratched,
        })
        .collect();
    Ok(RaceCard { entries })
}

fn draw<'a, R: Rng + ?Sized>(
    needed: usize,
    pool: &Pool<'a>,
    rng: &mut R,
) -> Result<Vec<&'a Country>, AssignError> {
    if needed == 0 {
        return Ok(Vec::new());
    }
    if pool.countries.is_empty() && pool.full.is_empty() {
        return Err(AssignError::EmptyPool);
    }
    let mut first = pool.countries.clone();
    first.shuffle(rng);
    first.truncate(needed);

    if first.len() < needed {
        let mut top_up: Vec<&Country> = pool
            .full
            .iter()
            .copied()
            .filter(|c| !first.iter().any(|f| f.iso2 == c.iso2))
            .collect();
        top_up.shuffle(rng);
        top_up.truncate(needed - first.len());
        first.extend(top_up);
    }

    if first.len() < needed {
        let distinct = first.clone();
        while first.len() < needed {
            let c = distinct.choose(rng).expect("pool checked non-empty");
            first.push(c);
        }
        // Repeats were appended last; shuffle so they aren't always the highest numbers.
        first.shuffle(rng);
    }
    Ok(first)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rand::SeedableRng;
    use rand::rngs::StdRng;

    use super::*;
    use crate::pool::pool;
    use crate::race::tests::runner;

    fn c(iso2: &str) -> Country {
        Country {
            iso2: iso2.into(),
            name: iso2.into(),
            flag: "🏳".into(),
            population: 20_000_000,
            cuisine_tags: vec!["x".into()],
            dishes: vec!["a".into(), "b".into(), "c".into()],
        }
    }

    fn countries(isos: &[&str]) -> Vec<Country> {
        isos.iter().map(|i| c(i)).collect()
    }

    fn visited(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn runners(n: u32) -> Vec<Runner> {
        (1..=n).map(|i| runner(i, false)).collect()
    }

    fn assigned(card: &RaceCard) -> Vec<String> {
        card.entries
            .iter()
            .filter_map(|e| e.country_iso.clone())
            .collect()
    }

    fn rng(seed: u64) -> StdRng {
        StdRng::seed_from_u64(seed)
    }

    #[test]
    fn distinct_when_the_pool_is_big_enough() {
        let all = countries(&["JP", "IT", "MX", "IN", "TH", "FR", "ET", "PE"]);
        let p = pool(&all, 0, &visited(&[]), false);
        for seed in 0..50 {
            let card = assign(&runners(8), &p, &mut rng(seed)).unwrap();
            let got = assigned(&card);
            assert_eq!(got.len(), 8);
            assert_eq!(got.iter().collect::<HashSet<_>>().len(), 8, "seed {seed}");
        }
    }

    #[test]
    fn uses_only_pool_countries_when_enough() {
        let all = countries(&["JP", "IT", "MX", "IN", "TH"]);
        let p = pool(&all, 0, &visited(&["JP", "IT"]), false);
        for seed in 0..50 {
            let got = assigned(&assign(&runners(3), &p, &mut rng(seed)).unwrap());
            let mut sorted = got.clone();
            sorted.sort();
            assert_eq!(sorted, ["IN", "MX", "TH"], "seed {seed}");
        }
    }

    #[test]
    fn tops_up_with_visited_countries_before_repeating() {
        let all = countries(&["JP", "IT", "MX", "IN"]);
        // Only MX and IN are unvisited; 4 runners need JP and IT too.
        let p = pool(&all, 0, &visited(&["JP", "IT"]), false);
        for seed in 0..50 {
            let got = assigned(&assign(&runners(4), &p, &mut rng(seed)).unwrap());
            let mut sorted = got.clone();
            sorted.sort();
            assert_eq!(sorted, ["IN", "IT", "JP", "MX"], "seed {seed}");
        }
    }

    #[test]
    fn repeats_only_when_forced() {
        let all = countries(&["JP", "IT"]);
        let p = pool(&all, 0, &visited(&[]), false);
        let got = assigned(&assign(&runners(5), &p, &mut rng(1)).unwrap());
        assert_eq!(got.len(), 5);
        let distinct: HashSet<_> = got.iter().collect();
        assert_eq!(distinct.len(), 2, "both countries used: {got:?}");
    }

    #[test]
    fn scratched_runners_get_no_country() {
        let all = countries(&["JP", "IT", "MX", "IN"]);
        let p = pool(&all, 0, &visited(&[]), false);
        let rs = vec![runner(1, false), runner(2, true), runner(3, false)];
        let card = assign(&rs, &p, &mut rng(7)).unwrap();
        assert_eq!(card.entries.len(), 3);
        assert!(card.entry(2).unwrap().country_iso.is_none());
        assert!(card.entry(2).unwrap().scratched);
        assert!(card.entry(1).unwrap().country_iso.is_some());
        assert!(card.entry(3).unwrap().country_iso.is_some());
    }

    #[test]
    fn same_seed_same_card() {
        let all = countries(&["JP", "IT", "MX", "IN", "TH", "FR"]);
        let p = pool(&all, 0, &visited(&[]), false);
        let a = assign(&runners(6), &p, &mut rng(42)).unwrap();
        let b = assign(&runners(6), &p, &mut rng(42)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_vary() {
        let all = countries(&["JP", "IT", "MX", "IN", "TH", "FR"]);
        let p = pool(&all, 0, &visited(&[]), false);
        let cards: HashSet<Vec<String>> = (0..20)
            .map(|s| assigned(&assign(&runners(6), &p, &mut rng(s)).unwrap()))
            .collect();
        assert!(cards.len() > 1);
    }

    #[test]
    fn empty_pool_is_an_error() {
        let all: Vec<Country> = vec![];
        let p = pool(&all, 0, &visited(&[]), false);
        assert_eq!(
            assign(&runners(3), &p, &mut rng(0)),
            Err(AssignError::EmptyPool)
        );
    }

    #[test]
    fn late_scratching_is_recorded() {
        let all = countries(&["JP", "IT", "MX"]);
        let p = pool(&all, 0, &visited(&[]), false);
        let mut card = assign(&runners(3), &p, &mut rng(3)).unwrap();
        card.apply_scratchings(&[runner(2, true), runner(3, false)]);
        assert!(card.entry(2).unwrap().scratched);
        assert!(card.entry(2).unwrap().country_iso.is_some());
        assert!(!card.entry(3).unwrap().scratched);
    }
}
