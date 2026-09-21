//! The country pool for a pick (SPEC.md F2).

use std::collections::HashSet;

use crate::countries::Country;

/// Default minimum population for the pool (SPEC.md F1.1).
pub const DEFAULT_MIN_POPULATION: u64 = 10_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool<'a> {
    /// Countries eligible to be assigned to horses.
    pub countries: Vec<&'a Country>,
    /// Countries passing the population threshold, visited or not (F2.2).
    /// Assignment tops up from here when `countries` is too small (F4.2).
    pub full: Vec<&'a Country>,
    /// Every country in `full` has been visited, so the whole of it is used (F2.4).
    pub world_complete: bool,
}

/// Build the pool (F2.2–F2.4). `visited` holds the ISO codes of countries with `visit_count > 0`.
pub fn pool<'a>(
    countries: &'a [Country],
    min_population: u64,
    visited: &HashSet<String>,
    include_visited: bool,
) -> Pool<'a> {
    let full: Vec<&Country> = countries
        .iter()
        .filter(|c| c.population >= min_population)
        .collect();
    if include_visited {
        return Pool {
            countries: full.clone(),
            full,
            world_complete: false,
        };
    }
    let unvisited: Vec<&Country> = full
        .iter()
        .copied()
        .filter(|c| !visited.contains(&c.iso2))
        .collect();
    if unvisited.is_empty() && !full.is_empty() {
        Pool {
            countries: full.clone(),
            full,
            world_complete: true,
        }
    } else {
        Pool {
            countries: unvisited,
            full,
            world_complete: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(iso2: &str, population: u64) -> Country {
        Country {
            iso2: iso2.into(),
            name: iso2.into(),
            flag: "🏳".into(),
            population,
            cuisine_tags: vec!["x".into()],
            dishes: vec!["a".into(), "b".into(), "c".into()],
        }
    }

    fn all() -> Vec<Country> {
        vec![
            c("JP", 120_000_000),
            c("IT", 58_000_000),
            c("PT", 10_000_000),
            c("NZ", 5_000_000),
        ]
    }

    fn isos(p: &[&Country]) -> Vec<String> {
        p.iter().map(|c| c.iso2.clone()).collect()
    }

    fn set(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn threshold_is_inclusive() {
        let all = all();
        let p = pool(&all, DEFAULT_MIN_POPULATION, &set(&[]), false);
        assert_eq!(isos(&p.countries), ["JP", "IT", "PT"]);
        assert_eq!(isos(&p.full), ["JP", "IT", "PT"]);
        assert!(!p.world_complete);
    }

    #[test]
    fn lower_threshold_includes_smaller_countries() {
        let all = all();
        let p = pool(&all, 1_000_000, &set(&[]), false);
        assert_eq!(isos(&p.countries), ["JP", "IT", "PT", "NZ"]);
    }

    #[test]
    fn visited_countries_are_excluded() {
        let all = all();
        let p = pool(&all, DEFAULT_MIN_POPULATION, &set(&["IT"]), false);
        assert_eq!(isos(&p.countries), ["JP", "PT"]);
        assert_eq!(isos(&p.full), ["JP", "IT", "PT"]);
        assert!(!p.world_complete);
    }

    #[test]
    fn include_visited_keeps_them() {
        let all = all();
        let p = pool(&all, DEFAULT_MIN_POPULATION, &set(&["IT"]), true);
        assert_eq!(isos(&p.countries), ["JP", "IT", "PT"]);
        assert!(!p.world_complete);
    }

    #[test]
    fn world_complete_uses_whole_pool() {
        let all = all();
        // NZ is below the threshold, so it doesn't need to be visited.
        let p = pool(
            &all,
            DEFAULT_MIN_POPULATION,
            &set(&["JP", "IT", "PT"]),
            false,
        );
        assert_eq!(isos(&p.countries), ["JP", "IT", "PT"]);
        assert!(p.world_complete);
    }

    #[test]
    fn nothing_above_threshold_is_empty_not_complete() {
        let all = all();
        let p = pool(&all, u64::MAX, &set(&[]), false);
        assert!(p.countries.is_empty());
        assert!(!p.world_complete);
    }
}
