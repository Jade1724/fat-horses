//! The committed `data/countries.json` must always load and validate (SPEC.md §4.1).

use fat_horses_domain::countries::CountriesFile;

const COUNTRIES_JSON: &str = include_str!("../../../data/countries.json");

#[test]
fn committed_countries_file_is_valid() {
    let file = CountriesFile::from_json(COUNTRIES_JSON).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(file.source.population, "World Bank WDI SP.POP.TOTL");
}

#[test]
fn covers_the_default_pool() {
    let file = CountriesFile::from_json(COUNTRIES_JSON).unwrap();
    let big = file
        .countries
        .iter()
        .filter(|c| c.population >= 10_000_000)
        .count();
    // 95 countries had >= 10M people in the World Bank 2025 data.
    assert!(big >= 90, "only {big} countries with >= 10M people");
    for iso2 in ["JP", "IT", "MX", "IN", "CN", "FR", "TH", "ET"] {
        assert!(file.get(iso2).is_some(), "{iso2} missing");
    }
}
