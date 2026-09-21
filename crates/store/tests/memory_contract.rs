use fat_horses_store::{MemoryStore, contract};

#[tokio::test]
async fn memory_store_passes_the_contract() {
    contract::run_all(MemoryStore::new).await;
}
