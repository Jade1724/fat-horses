//! AWS Lambda wiring (SPEC.md §6). Logic lives in `app`; this crate only reads
//! configuration from the environment and builds clients.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use app::api::{Method, Request, WorkflowStarter};
use app::workflow::Config;
use domain::classify::FakeClassifier;
use domain::guessing::GuessConfig;
use places::overpass::{self, Overpass};
use race::{Identity, TabNz};
use store::DynamoStore;

/// Required environment variable.
pub fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("missing environment variable {name}"))
}

/// JSON logs for CloudWatch (N7).
pub fn init_tracing() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_current_span(false)
        .without_time()
        .init();
}

pub async fn aws_config() -> aws_config::SdkConfig {
    aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await
}

/// The DynamoDB store for `TABLE_NAME`.
pub fn dynamo_store(config: &aws_config::SdkConfig) -> Result<DynamoStore> {
    Ok(DynamoStore::new(
        aws_sdk_dynamodb::Client::new(config),
        env("TABLE_NAME")?,
    ))
}

/// Read a SecureString parameter (the API key, F11.1).
pub async fn secure_parameter(config: &aws_config::SdkConfig, name: &str) -> Result<String> {
    let out = aws_sdk_ssm::Client::new(config)
        .get_parameter()
        .name(name)
        .with_decryption(true)
        .send()
        .await
        .with_context(|| format!("reading SSM parameter {name}"))?;
    out.parameter
        .and_then(|p| p.value)
        .with_context(|| format!("SSM parameter {name} has no value"))
}

/// Starts the pick state machine; the execution is named after the pick.
pub struct SfnStarter {
    client: aws_sdk_sfn::Client,
    state_machine_arn: String,
}

impl SfnStarter {
    pub fn new(config: &aws_config::SdkConfig, state_machine_arn: String) -> Self {
        Self {
            client: aws_sdk_sfn::Client::new(config),
            state_machine_arn,
        }
    }
}

impl WorkflowStarter for SfnStarter {
    async fn start(&self, pick_id: &str) -> std::result::Result<(), String> {
        self.client
            .start_execution()
            .state_machine_arn(&self.state_machine_arn)
            .name(pick_id)
            .input(serde_json::json!({ "pick_id": pick_id }).to_string())
            .send()
            .await
            .map(|_| ())
            .map_err(|e| aws_sdk_sfn::error::DisplayErrorContext(e).to_string())
    }
}

/// The TAB NZ client, with optional identity headers from the environment.
pub fn tab_nz() -> Result<TabNz> {
    Ok(TabNz::new(
        race::tab_nz::DEFAULT_BASE_URL,
        Identity::from_env(),
    )?)
}

pub fn overpass() -> Result<Overpass> {
    Ok(Overpass::new(
        places::http_client(Duration::from_secs(40))?,
        overpass::DEFAULT_ENDPOINTS
            .iter()
            .map(|s| s.to_string())
            .collect(),
    ))
}

/// The classifier until Bedrock is wired in (T3.9): guesses nothing, so only
/// tagged matches (tier 1) are found.
pub fn classifier() -> FakeClassifier {
    FakeClassifier::new()
}

pub fn workflow_config() -> Config {
    Config {
        guess: GuessConfig {
            prompt_version: 1,
            model_id: std::env::var("BEDROCK_MODEL_ID").unwrap_or_else(|_| "none".into()),
        },
        ..Config::default()
    }
}

/// Map an API Gateway request to the framework-free API request. `raw_path` is
/// the full path (e.g. `/api/picks/01J…`), still percent-encoded.
pub fn api_request(
    method: &str,
    raw_path: &str,
    query: HashMap<String, String>,
    api_key: Option<String>,
    body: Option<String>,
) -> Request {
    Request {
        method: match method {
            "GET" => Method::Get,
            "POST" => Method::Post,
            _ => Method::Other,
        },
        path: raw_path
            .strip_prefix("/api")
            .unwrap_or(raw_path)
            .to_string(),
        query,
        api_key,
        body: body.filter(|b| !b.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_requests() {
        let r = api_request(
            "POST",
            "/api/restaurants/osm%3Anode%2F1/visit",
            HashMap::new(),
            Some("k".into()),
            Some(String::new()),
        );
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.path, "/restaurants/osm%3Anode%2F1/visit");
        assert_eq!(r.api_key.as_deref(), Some("k"));
        assert!(r.body.is_none());
        let r = api_request("DELETE", "/history", HashMap::new(), None, None);
        assert_eq!(r.method, Method::Other);
        assert_eq!(r.path, "/history");
    }
}
