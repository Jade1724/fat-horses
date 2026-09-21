//! Choosing the restaurant (SPEC.md F7). The LLM never takes part here.

use rand::Rng;
use rand::seq::IndexedRandom;

use crate::matching::Match;

/// Choose one match uniformly at random (F7.1–F7.3): primary matches, or fallback
/// matches when there are no primary ones; among them, only never-visited
/// restaurants if there are any. `visit_count` gives a place's stored visit count
/// (0 when not stored).
pub fn choose_restaurant<'a, R: Rng + ?Sized>(
    primary: &'a [Match],
    fallback: &'a [Match],
    visit_count: impl Fn(&str) -> u32,
    rng: &mut R,
) -> Option<&'a Match> {
    let candidates = if primary.is_empty() {
        fallback
    } else {
        primary
    };
    let fresh: Vec<&Match> = candidates
        .iter()
        .filter(|m| visit_count(&m.place_id) == 0)
        .collect();
    if fresh.is_empty() {
        candidates.choose(rng)
    } else {
        fresh.choose(rng).copied()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rand::SeedableRng;
    use rand::rngs::StdRng;

    use super::*;
    use crate::matching::MatchKind;

    fn m(id: &str, kind: MatchKind) -> Match {
        Match {
            place_id: id.into(),
            kind,
            reason: None,
        }
    }

    fn never(_: &str) -> u32 {
        0
    }

    fn picks(primary: &[Match], fallback: &[Match], visited: &[&str]) -> HashSet<String> {
        (0..100)
            .filter_map(|seed| {
                choose_restaurant(
                    primary,
                    fallback,
                    |id| u32::from(visited.contains(&id)),
                    &mut StdRng::seed_from_u64(seed),
                )
                .map(|m| m.place_id.clone())
            })
            .collect()
    }

    fn set(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn chooses_among_all_primary_matches() {
        let primary = [m("a", MatchKind::Tagged), m("b", MatchKind::Inferred)];
        assert_eq!(picks(&primary, &[], &[]), set(&["a", "b"]));
    }

    #[test]
    fn prefers_never_visited() {
        let primary = [
            m("a", MatchKind::Tagged),
            m("b", MatchKind::Tagged),
            m("c", MatchKind::Tagged),
        ];
        assert_eq!(picks(&primary, &[], &["a", "b"]), set(&["c"]));
    }

    #[test]
    fn falls_back_to_visited_when_all_visited() {
        let primary = [m("a", MatchKind::Tagged), m("b", MatchKind::Tagged)];
        assert_eq!(picks(&primary, &[], &["a", "b"]), set(&["a", "b"]));
    }

    #[test]
    fn fallback_only_when_no_primary() {
        let primary = [m("a", MatchKind::Tagged)];
        let fallback = [m("f", MatchKind::Fallback)];
        assert_eq!(picks(&primary, &fallback, &["a"]), set(&["a"]));
        assert_eq!(picks(&[], &fallback, &[]), set(&["f"]));
    }

    #[test]
    fn nothing_to_choose_is_none() {
        assert!(choose_restaurant(&[], &[], never, &mut StdRng::seed_from_u64(0)).is_none());
    }

    #[test]
    fn same_seed_same_choice() {
        let primary: Vec<Match> = (0..10)
            .map(|i| m(&format!("p{i}"), MatchKind::Tagged))
            .collect();
        let a = choose_restaurant(&primary, &[], never, &mut StdRng::seed_from_u64(5));
        let b = choose_restaurant(&primary, &[], never, &mut StdRng::seed_from_u64(5));
        assert_eq!(a, b);
    }
}
