//! Runs the store contract against DynamoDB Local. Used by `make it`, not `make check`.
//!
//! Needs `FAT_HORSES_DYNAMODB_ENDPOINT` (default `http://localhost:8000`).

use std::sync::atomic::{AtomicUsize, Ordering};

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::config::{Credentials, Region};
use fat_horses_store::contract;
use fat_horses_store::dynamo::{DynamoStore, create_table};

/// One table per contract scenario, so each starts empty.
const TABLES: usize = 20;

#[tokio::main]
async fn main() {
    let endpoint = std::env::var("FAT_HORSES_DYNAMODB_ENDPOINT")
        .unwrap_or_else(|_| "http://localhost:8000".into());
    let config = aws_sdk_dynamodb::Config::builder()
        .behavior_version_latest()
        .endpoint_url(&endpoint)
        .region(Region::new("ap-southeast-2"))
        .credentials_provider(Credentials::new("local", "local", None, None, "static"))
        .build();
    let client = Client::from_conf(config);

    let run = std::process::id();
    let names: Vec<String> = (0..TABLES).map(|i| format!("contract-{run}-{i}")).collect();
    for name in &names {
        create_table(&client, name).await.expect("create table");
    }
    let next = AtomicUsize::new(0);
    contract::run_all(|| {
        let i = next.fetch_add(1, Ordering::SeqCst);
        DynamoStore::new(client.clone(), names[i].clone())
    })
    .await;
    for name in &names {
        let _ = client.delete_table().table_name(name).send().await;
    }
    println!(
        "dynamo contract: OK ({} scenarios)",
        next.load(Ordering::SeqCst)
    );
}
