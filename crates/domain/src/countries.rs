//! Country data (SPEC.md §4.1): the `data/countries.json` model, loader and validation.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Minimum and maximum number of `dishes` per country (SPEC.md §4.1).
pub const DISHES_MIN: usize = 3;
pub const DISHES_MAX: usize = 12;

/// `data/countries.json` as built into the binary.
pub const BUNDLED_JSON: &str = include_str!("../../../data/countries.json");

/// The whole `data/countries.json` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CountriesFile {
    pub source: Source,
    pub countries: Vec<Country>,
}

/// Where the population figures come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub population: String,
    pub year: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Country {
    /// ISO 3166-1 alpha-2 code, uppercase.
    pub iso2: String,
    pub name: String,
    pub flag: String,
    pub population: u64,
    /// OSM `cuisine=*` values that count as this country's food.
    pub cuisine_tags: Vec<String>,
    /// Signature dishes and ingredients, used by the LLM fallback.
    pub dishes: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("countries file is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("countries file is invalid:\n{}", .0.iter().map(|e| format!("  - {e}")).collect::<Vec<_>>().join("\n"))]
    Invalid(Vec<ValidationError>),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("no countries")]
    Empty,
    #[error("{iso2:?}: iso2 must be two uppercase ASCII letters")]
    BadIso2 { iso2: String },
    #[error("{iso2}: duplicate iso2")]
    DuplicateIso2 { iso2: String },
    #[error("{iso2}: name is empty")]
    EmptyName { iso2: String },
    #[error("{iso2}: flag is empty")]
    EmptyFlag { iso2: String },
    #[error("{iso2}: population must be > 0")]
    ZeroPopulation { iso2: String },
    #[error("{iso2}: cuisine_tags is empty")]
    NoCuisineTags { iso2: String },
    #[error("{iso2}: cuisine tag {tag:?} must match [a-z_]+")]
    BadCuisineTag { iso2: String, tag: String },
    #[error("{iso2}: has {count} dishes, expected {DISHES_MIN}..={DISHES_MAX}")]
    DishCount { iso2: String, count: usize },
    #[error("{iso2}: dish is empty")]
    EmptyDish { iso2: String },
}

impl CountriesFile {
    /// The bundled countries file. Its validity is checked by a test.
    pub fn bundled() -> Self {
        Self::from_json(BUNDLED_JSON).expect("bundled data/countries.json is valid")
    }

    /// Parse and validate a countries file.
    pub fn from_json(json: &str) -> Result<Self, LoadError> {
        let file: CountriesFile = serde_json::from_str(json)?;
        let errors = file.validate();
        if errors.is_empty() {
            Ok(file)
        } else {
            Err(LoadError::Invalid(errors))
        }
    }

    /// Every rule of SPEC.md §4.1 that the file breaks. Empty means valid.
    pub fn validate(&self) -> Vec<ValidationError> {
        let mut errors = Vec::new();
        if self.countries.is_empty() {
            errors.push(ValidationError::Empty);
        }
        let mut seen = HashSet::new();
        for c in &self.countries {
            let iso2 = c.iso2.clone();
            if c.iso2.len() != 2 || !c.iso2.bytes().all(|b| b.is_ascii_uppercase()) {
                errors.push(ValidationError::BadIso2 { iso2: iso2.clone() });
            }
            if !seen.insert(c.iso2.as_str()) {
                errors.push(ValidationError::DuplicateIso2 { iso2: iso2.clone() });
            }
            if c.name.trim().is_empty() {
                errors.push(ValidationError::EmptyName { iso2: iso2.clone() });
            }
            if c.flag.trim().is_empty() {
                errors.push(ValidationError::EmptyFlag { iso2: iso2.clone() });
            }
            if c.population == 0 {
                errors.push(ValidationError::ZeroPopulation { iso2: iso2.clone() });
            }
            if c.cuisine_tags.is_empty() {
                errors.push(ValidationError::NoCuisineTags { iso2: iso2.clone() });
            }
            for tag in &c.cuisine_tags {
                if !is_valid_tag(tag) {
                    errors.push(ValidationError::BadCuisineTag {
                        iso2: iso2.clone(),
                        tag: tag.clone(),
                    });
                }
            }
            if !(DISHES_MIN..=DISHES_MAX).contains(&c.dishes.len()) {
                errors.push(ValidationError::DishCount {
                    iso2: iso2.clone(),
                    count: c.dishes.len(),
                });
            }
            if c.dishes.iter().any(|d| d.trim().is_empty()) {
                errors.push(ValidationError::EmptyDish { iso2 });
            }
        }
        errors
    }

    /// The union of every country's cuisine tags: the only tags the LLM may return (SPEC.md L4).
    pub fn known_tags(&self) -> HashSet<&str> {
        self.countries
            .iter()
            .flat_map(|c| c.cuisine_tags.iter().map(String::as_str))
            .collect()
    }

    pub fn get(&self, iso2: &str) -> Option<&Country> {
        self.countries.iter().find(|c| c.iso2 == iso2)
    }
}

fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn country(iso2: &str) -> Country {
        Country {
            iso2: iso2.to_string(),
            name: "Japan".to_string(),
            flag: "🇯🇵".to_string(),
            population: 124_000_000,
            cuisine_tags: vec!["japanese".to_string(), "sushi".to_string()],
            dishes: vec!["sushi".into(), "ramen".into(), "miso".into()],
        }
    }

    fn file(countries: Vec<Country>) -> CountriesFile {
        CountriesFile {
            source: Source {
                population: "World Bank WDI SP.POP.TOTL".to_string(),
                year: 2024,
            },
            countries,
        }
    }

    fn errors_for(edit: impl FnOnce(&mut Country)) -> Vec<ValidationError> {
        let mut c = country("JP");
        edit(&mut c);
        file(vec![c]).validate()
    }

    #[test]
    fn valid_file_parses() {
        let json = r#"{
          "source": { "population": "World Bank WDI SP.POP.TOTL", "year": 2024 },
          "countries": [{
            "iso2": "JP", "name": "Japan", "flag": "🇯🇵", "population": 124000000,
            "cuisine_tags": ["japanese", "sushi", "ramen"],
            "dishes": ["sushi", "ramen", "tempura"]
          }]
        }"#;
        let f = CountriesFile::from_json(json).unwrap();
        assert_eq!(f.countries.len(), 1);
        assert_eq!(f.get("JP").unwrap().name, "Japan");
        assert!(f.get("FR").is_none());
    }

    #[test]
    fn empty_file_is_invalid() {
        assert_eq!(file(vec![]).validate(), vec![ValidationError::Empty]);
    }

    #[test]
    fn iso2_must_be_two_uppercase_letters() {
        for bad in ["jp", "JPN", "J", "J1", ""] {
            let errs = errors_for(|c| c.iso2 = bad.to_string());
            assert!(
                errs.contains(&ValidationError::BadIso2 {
                    iso2: bad.to_string()
                }),
                "{bad:?}: {errs:?}"
            );
        }
    }

    #[test]
    fn iso2_must_be_unique() {
        let errs = file(vec![country("JP"), country("JP")]).validate();
        assert_eq!(
            errs,
            vec![ValidationError::DuplicateIso2 {
                iso2: "JP".to_string()
            }]
        );
    }

    #[test]
    fn name_and_flag_must_not_be_empty() {
        assert!(
            errors_for(|c| c.name = " ".into())
                .contains(&ValidationError::EmptyName { iso2: "JP".into() })
        );
        assert!(
            errors_for(|c| c.flag = String::new())
                .contains(&ValidationError::EmptyFlag { iso2: "JP".into() })
        );
    }

    #[test]
    fn population_must_be_positive() {
        assert_eq!(
            errors_for(|c| c.population = 0),
            vec![ValidationError::ZeroPopulation { iso2: "JP".into() }]
        );
    }

    #[test]
    fn cuisine_tags_must_be_present_and_lowercase_snake() {
        assert_eq!(
            errors_for(|c| c.cuisine_tags.clear()),
            vec![ValidationError::NoCuisineTags { iso2: "JP".into() }]
        );
        for bad in ["Japanese", "sushi bar", "sushi-bar", "", "ramen1"] {
            let errs = errors_for(|c| c.cuisine_tags = vec![bad.to_string()]);
            assert_eq!(
                errs,
                vec![ValidationError::BadCuisineTag {
                    iso2: "JP".into(),
                    tag: bad.to_string()
                }],
                "{bad:?}"
            );
        }
        assert!(errors_for(|c| c.cuisine_tags = vec!["sushi_bar".into()]).is_empty());
    }

    #[test]
    fn dishes_count_is_bounded() {
        assert_eq!(
            errors_for(|c| c.dishes.truncate(2)),
            vec![ValidationError::DishCount {
                iso2: "JP".into(),
                count: 2
            }]
        );
        assert_eq!(
            errors_for(|c| c.dishes = vec!["x".to_string(); 13]),
            vec![ValidationError::DishCount {
                iso2: "JP".into(),
                count: 13
            }]
        );
        assert!(errors_for(|c| c.dishes = vec!["x".to_string(); 12]).is_empty());
    }

    #[test]
    fn dishes_must_not_be_blank() {
        assert_eq!(
            errors_for(|c| c.dishes[0] = "  ".into()),
            vec![ValidationError::EmptyDish { iso2: "JP".into() }]
        );
    }

    #[test]
    fn from_json_reports_all_problems() {
        let json = r#"{
          "source": { "population": "x", "year": 2024 },
          "countries": [{ "iso2": "jp", "name": "", "flag": "f", "population": 0,
                          "cuisine_tags": [], "dishes": [] }]
        }"#;
        match CountriesFile::from_json(json) {
            Err(LoadError::Invalid(errs)) => assert_eq!(errs.len(), 5, "{errs:?}"),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn from_json_rejects_bad_json() {
        assert!(matches!(
            CountriesFile::from_json("{"),
            Err(LoadError::Json(_))
        ));
    }

    #[test]
    fn known_tags_is_the_union() {
        let mut fr = country("FR");
        fr.cuisine_tags = vec!["french".into(), "sushi".into()];
        let f = file(vec![country("JP"), fr]);
        let mut tags: Vec<_> = f.known_tags().into_iter().collect();
        tags.sort();
        assert_eq!(tags, ["french", "japanese", "sushi"]);
    }
}
