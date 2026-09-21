use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::Utc;
use domain::status::Status;
use domain::store::{VisitStore, record_pick, record_visit};
use fat_horses_store::{FileStore, contract};

#[tokio::test]
async fn file_store_passes_the_contract() {
    let dir = tempfile::tempdir().unwrap();
    let n = AtomicUsize::new(0);
    contract::run_all(|| {
        let i = n.fetch_add(1, Ordering::SeqCst);
        FileStore::open(dir.path().join(format!("store-{i}.json"))).unwrap()
    })
    .await;
}

#[tokio::test]
async fn data_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/store.json");
    {
        let s = FileStore::open(&path).unwrap();
        record_pick(
            &s,
            contract::restaurant("osm:node/1", "JP"),
            "p1",
            Utc::now(),
        )
        .await
        .unwrap();
        record_visit(&s, "osm:node/1", None, Utc::now())
            .await
            .unwrap();
    }
    let s = FileStore::open(&path).unwrap();
    let r = s.get_restaurant("osm:node/1").await.unwrap().unwrap();
    assert_eq!(r.status, Some(Status::Visited));
    assert_eq!(s.country_visits().await.unwrap()[0].iso2, "JP");
    assert_eq!(s.history(None, 10).await.unwrap().entries.len(), 2);
}

#[tokio::test]
async fn corrupt_file_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.json");
    std::fs::write(&path, "{not json").unwrap();
    assert!(FileStore::open(&path).is_err());
}
