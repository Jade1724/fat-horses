//! `fat-horses`: run picks and manage visits from the terminal (SPEC.md §7).

mod render;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use app::start::{StartInput, new_pick_id, start_pick};
use app::workflow::{Config, Deps, SystemClock, run_pick};
use clap::{Parser, Subcommand};
use domain::classify::FakeClassifier;
use domain::countries::CountriesFile;
use domain::store::{HISTORY_PAGE, StoreError, VisitStore, record_skip, record_visit};
use places::nominatim::{self, Nominatim};
use places::overpass::{self, Overpass};
use race::{Identity, TabNz};
use rand::SeedableRng;
use rand::rngs::StdRng;
use store::FileStore;

#[derive(Parser)]
#[command(
    name = "fat-horses",
    version,
    about = "Let a horse race pick your restaurant"
)]
struct Cli {
    /// Store file (default: ~/.local/share/fat-horses/store.json).
    #[arg(long, global = true)]
    store: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a whole pick: find a race, wait for it, pick a restaurant.
    Pick {
        /// Address to search around.
        address: String,
        /// Search radius in metres (50–2000).
        #[arg(long, default_value_t = app::start::DEFAULT_RADIUS_M)]
        radius: u32,
        /// Only countries with at least this many people.
        #[arg(long, default_value_t = domain::pool::DEFAULT_MIN_POPULATION)]
        min_population: u64,
        /// Also race countries you have already visited.
        #[arg(long)]
        include_visited: bool,
        /// Use a classifier that guesses nothing instead of Bedrock.
        #[arg(long)]
        fake_llm: bool,
    },
    /// "We went here": mark a picked restaurant visited.
    Visit {
        /// Restaurant id, e.g. osm:node/123.
        id: String,
    },
    /// Skip the picked restaurant.
    Skip {
        /// Restaurant id, e.g. osm:node/123.
        id: String,
    },
    /// Which countries you have visited.
    Passport {
        #[arg(long, default_value_t = domain::pool::DEFAULT_MIN_POPULATION)]
        min_population: u64,
    },
    /// Every status change, newest first.
    History {
        /// Continue from a previous page.
        #[arg(long)]
        cursor: Option<String>,
    },
}

fn open_store(path: Option<PathBuf>) -> Result<FileStore> {
    let path = match path {
        Some(p) => p,
        None => {
            store::file::default_path().context("cannot find a home directory; pass --store")?
        }
    };
    FileStore::open(&path).with_context(|| format!("opening store {}", path.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let store = open_store(cli.store)?;
    match cli.command {
        Command::Pick {
            address,
            radius,
            min_population,
            include_visited,
            fake_llm,
        } => {
            if !fake_llm {
                bail!("the Bedrock classifier isn't built yet (TASKS.md T3.9); pass --fake-llm");
            }
            pick(
                store,
                StartInput {
                    address: Some(address),
                    radius_m: Some(radius),
                    min_population: Some(min_population),
                    include_visited: Some(include_visited),
                    ..Default::default()
                },
            )
            .await
        }
        Command::Visit { id } => {
            let r = match record_visit(&store, &id, None, chrono::Utc::now()).await {
                Err(StoreError::NotFound) => bail!(
                    "{id} isn't a stored restaurant; only picked restaurants can be visited from the CLI"
                ),
                other => other?,
            };
            print!("{}", render::restaurant(&r, &CountriesFile::bundled()));
            Ok(())
        }
        Command::Skip { id } => {
            let r = record_skip(&store, &id, chrono::Utc::now()).await?;
            print!("{}", render::restaurant(&r, &CountriesFile::bundled()));
            Ok(())
        }
        Command::Passport { min_population } => {
            let visits = store.country_visits().await?;
            print!(
                "{}",
                render::passport(&CountriesFile::bundled(), &visits, min_population)
            );
            Ok(())
        }
        Command::History { cursor } => {
            let page = store.history(cursor, HISTORY_PAGE).await?;
            print!("{}", render::history(&page, &CountriesFile::bundled()));
            Ok(())
        }
    }
}

async fn pick(store: FileStore, input: StartInput) -> Result<()> {
    let http = places::http_client(Duration::from_secs(60))?;
    let geocoder = Nominatim::new(http.clone(), nominatim::DEFAULT_BASE_URL);
    let countries = CountriesFile::bundled();
    let now = chrono::Utc::now();
    let session = start_pick(&geocoder, &store, input, new_pick_id(), now).await?;
    println!("📍 {}", session.location.display_name);

    let deps = Deps {
        races: TabNz::new(race::tab_nz::DEFAULT_BASE_URL, Identity::from_env())?,
        places: Overpass::new(
            http,
            overpass::DEFAULT_ENDPOINTS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        ),
        classifier: FakeClassifier::new(),
        store,
        countries,
        config: Config::default(),
    };
    let mut rng = StdRng::from_rng(&mut rand::rng());
    let mut printer = render::Printer::default();
    let done = run_pick(&deps, session, &SystemClock, &mut rng, |s| {
        printer.update(s, &deps.countries)
    })
    .await?;
    print!("{}", render::summary(&done, &deps.countries));
    Ok(())
}
