//! The HTTP API behind API Gateway (SPEC.md §5).
//!
//! Environment: `TABLE_NAME`, `API_KEY_PARAM` (SSM SecureString name, read at
//! cold start), `STATE_MACHINE_ARN`.

use std::sync::Arc;
use std::time::Duration;

use app::api::Api;
use domain::countries::CountriesFile;
use fat_horses_lambdas as l;
use lambda_http::{Body, Error, Request, RequestExt, Response, service_fn};
use places::nominatim::{self, Nominatim};

#[tokio::main]
async fn main() -> Result<(), Error> {
    l::init_tracing();
    let config = l::aws_config().await;
    let api = Arc::new(Api {
        geocoder: Nominatim::new(
            places::http_client(Duration::from_secs(10))?,
            nominatim::DEFAULT_BASE_URL,
        ),
        store: l::dynamo_store(&config)?,
        starter: l::SfnStarter::new(&config, l::env("STATE_MACHINE_ARN")?),
        countries: CountriesFile::bundled(),
        api_key: l::secure_parameter(&config, &l::env("API_KEY_PARAM")?).await?,
    });
    lambda_http::run(service_fn(move |req: Request| {
        let api = api.clone();
        async move { handle(&api, req).await }
    }))
    .await
}

async fn handle<G, S, W>(api: &Api<G, S, W>, req: Request) -> Result<Response<Body>, Error>
where
    G: domain::geo::Geocoder + Sync,
    S: domain::store::VisitStore + domain::store::PickStore + domain::store::GeocodeCache + Sync,
    W: app::api::WorkflowStarter + Sync,
{
    let query = req
        .query_string_parameters()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let api_key = req
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = match req.body() {
        Body::Text(t) => Some(t.clone()),
        Body::Binary(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Body::Empty => None,
        _ => None,
    };
    let request = l::api_request(
        req.method().as_str(),
        req.raw_http_path(),
        query,
        api_key,
        body,
    );
    let resp = api.handle(request, chrono::Utc::now()).await;
    Ok(Response::builder()
        .status(resp.status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::Text(resp.body.to_string()))?)
}
