//! `fat-horses serve`: the HTTP API on localhost for UI development (T4.5).
//! Picks run in-process in the background; the store is the CLI's JSON file.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use app::api::{Api, Method, Request, WorkflowStarter};
use app::workflow::{Config, Deps, SystemClock, run_pick};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Json};
use axum::routing::any;
use domain::classify::FakeClassifier;
use domain::countries::CountriesFile;
use domain::store::PickStore;
use places::nominatim::{self, Nominatim};
use places::overpass::{self, Overpass};
use race::{Identity, TabNz};
use rand::SeedableRng;
use rand::rngs::StdRng;
use store::FileStore;

type Store = Arc<FileStore>;
type LocalApi = Api<Nominatim, Store, LocalStarter>;

/// Runs each pick as a background task in this process.
pub struct LocalStarter {
    store: Store,
    http: reqwest::Client,
}

impl WorkflowStarter for LocalStarter {
    async fn start(&self, pick_id: &str) -> Result<(), String> {
        let session = self
            .store
            .get_pick(pick_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("pick not stored")?;
        let races = TabNz::new(race::tab_nz::DEFAULT_BASE_URL, Identity::from_env())
            .map_err(|e| e.to_string())?;
        let deps = Deps {
            races,
            places: Overpass::new(
                self.http.clone(),
                overpass::DEFAULT_ENDPOINTS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ),
            classifier: FakeClassifier::new(),
            store: self.store.clone(),
            countries: CountriesFile::bundled(),
            config: Config::default(),
        };
        let id = pick_id.to_string();
        tokio::spawn(async move {
            let mut rng = StdRng::from_rng(&mut rand::rng());
            match run_pick(&deps, session, &SystemClock, &mut rng, |_| {}).await {
                Ok(s) => tracing::info!(pick_id = %id, status = ?s.status, "pick finished"),
                Err(e) => tracing::error!(pick_id = %id, error = %e, "pick failed"),
            }
        });
        Ok(())
    }
}

async fn handle(
    State(api): State<Arc<LocalApi>>,
    method: axum::http::Method,
    uri: Uri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let method = match method {
        axum::http::Method::GET => Method::Get,
        axum::http::Method::POST => Method::Post,
        _ => Method::Other,
    };
    // `uri.path()` keeps percent-encoding; the handler decodes it.
    let path = uri
        .path()
        .strip_prefix("/api")
        .unwrap_or(uri.path())
        .to_string();
    let req = Request {
        method,
        path,
        query,
        api_key: headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        body: (!body.is_empty()).then(|| String::from_utf8_lossy(&body).into_owned()),
    };
    let resp = api.handle(req, chrono::Utc::now()).await;
    (
        StatusCode::from_u16(resp.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(resp.body),
    )
}

pub async fn serve(
    store: FileStore,
    port: u16,
    api_key: String,
    web_dir: Option<PathBuf>,
) -> Result<()> {
    let http = places::http_client(Duration::from_secs(60))?;
    let store = Arc::new(store);
    let api = Arc::new(Api {
        geocoder: Nominatim::new(http.clone(), nominatim::DEFAULT_BASE_URL),
        store: store.clone(),
        starter: LocalStarter { store, http },
        countries: CountriesFile::bundled(),
        api_key,
    });
    let mut app = Router::new()
        .route("/api/{*rest}", any(handle))
        .with_state(api);
    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .fallback(tower_http::services::ServeFile::new(index)),
        );
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!("Serving the API on http://{addr}/api");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
