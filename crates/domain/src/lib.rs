//! Domain types and rules for fat-horses (SPEC.md F2–F8). No I/O.

/// Crate version, used in the CLI banner and the HTTP User-Agent.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!VERSION.is_empty());
    }
}
