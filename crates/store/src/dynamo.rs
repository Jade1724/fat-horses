//! DynamoDB single-table store (SPEC.md §4.2).
//!
//! Records are kept as JSON in a `data` attribute; attributes used in conditions
//! and updates (`status`, `restaurant_id`, country counters, `ttl`) are top level.

use std::collections::HashMap;

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::error::SdkError;
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::types::{
    AttributeDefinition, AttributeValue, BillingMode, ConditionCheck, Delete, KeySchemaElement,
    KeyType, Put, ScalarAttributeType, TransactWriteItem, Update,
};
use chrono::{DateTime, Duration, Utc};
use domain::session::PickSession;
use domain::status::{Restaurant, Status};
use domain::store::{
    CachedGuess, CachedLocation, Change, CountryVisits, GEOCODE_TTL, GUESS_TTL, GeocodeCache,
    GuessCache, HistoryPage, PICK_TTL, PickStore, StoreError, VisitStore, log_key, picked_after,
};
use serde::Serialize;
use serde::de::DeserializeOwned;

type Item = HashMap<String, AttributeValue>;

pub struct DynamoStore {
    client: Client,
    table: String,
}

impl DynamoStore {
    pub fn new(client: Client, table: impl Into<String>) -> Self {
        Self {
            client,
            table: table.into(),
        }
    }

    async fn get_item(&self, pk: &str, sk: &str) -> Result<Option<Item>, StoreError> {
        let out = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(key(pk, sk)))
            .consistent_read(true)
            .send()
            .await
            .map_err(unavailable)?;
        Ok(out.item)
    }

    async fn get_data<T: DeserializeOwned>(
        &self,
        pk: &str,
        sk: &str,
    ) -> Result<Option<T>, StoreError> {
        match self.get_item(pk, sk).await? {
            Some(item) => Ok(Some(data(&item)?)),
            None => Ok(None),
        }
    }

    async fn put_data<T: Serialize>(
        &self,
        pk: &str,
        sk: &str,
        value: &T,
        ttl: Option<DateTime<Utc>>,
    ) -> Result<(), StoreError> {
        let mut item = key(pk, sk);
        item.insert("data".into(), AttributeValue::S(to_json(value)?));
        if let Some(t) = ttl {
            item.insert("ttl".into(), AttributeValue::N(t.timestamp().to_string()));
        }
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(item))
            .send()
            .await
            .map_err(unavailable)?;
        Ok(())
    }
}

/// Create the table with the §4.2 key schema (for local development and tests;
/// Terraform owns the real table).
pub async fn create_table(client: &Client, table: &str) -> Result<(), StoreError> {
    let attr = |name: &str| {
        AttributeDefinition::builder()
            .attribute_name(name)
            .attribute_type(ScalarAttributeType::S)
            .build()
            .expect("attribute definition")
    };
    let key_el = |name: &str, kind| {
        KeySchemaElement::builder()
            .attribute_name(name)
            .key_type(kind)
            .build()
            .expect("key schema")
    };
    client
        .create_table()
        .table_name(table)
        .attribute_definitions(attr("pk"))
        .attribute_definitions(attr("sk"))
        .key_schema(key_el("pk", KeyType::Hash))
        .key_schema(key_el("sk", KeyType::Range))
        .billing_mode(BillingMode::PayPerRequest)
        .send()
        .await
        .map_err(unavailable)?;
    Ok(())
}

fn key(pk: &str, sk: &str) -> Item {
    HashMap::from([
        ("pk".to_string(), AttributeValue::S(pk.to_string())),
        ("sk".to_string(), AttributeValue::S(sk.to_string())),
    ])
}

fn unavailable(e: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable(e.to_string())
}

fn to_json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(unavailable)
}

fn data<T: DeserializeOwned>(item: &Item) -> Result<T, StoreError> {
    let s = item
        .get("data")
        .and_then(|v| v.as_s().ok())
        .ok_or_else(|| StoreError::Unavailable("item has no data".into()))?;
    serde_json::from_str(s).map_err(unavailable)
}

fn status_str(s: Status) -> &'static str {
    match s {
        Status::Picked => "PICKED",
        Status::Visited => "VISITED",
    }
}

fn restaurant_pk(id: &str) -> String {
    format!("RESTAURANT#{id}")
}

const META: &str = "META";
const STATE_PK: &str = "STATE";
const PICKED_SK: &str = "PICKED";
const COUNTRY_PK: &str = "COUNTRY";
const LOG_PK: &str = "LOG";

/// The single write on the `STATE/PICKED` pointer within a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PointerOp {
    /// Pointer unchanged; only check it still equals `expected`.
    Check {
        expected: Option<String>,
    },
    Set {
        expected: Option<String>,
        to: String,
    },
    Clear {
        expected: String,
    },
}

pub fn pointer_op(change: &Change) -> PointerOp {
    let expected = change.expected_picked.clone();
    match (picked_after(change), expected) {
        (after, expected) if after == expected => PointerOp::Check { expected },
        (Some(to), expected) => PointerOp::Set { expected, to },
        (None, Some(expected)) => PointerOp::Clear { expected },
        (None, None) => unreachable!("covered by the equality arm"),
    }
}

/// Condition that the pointer currently equals `expected`.
fn pointer_condition(expected: &Option<String>) -> (String, Option<(String, AttributeValue)>) {
    match expected {
        None => ("attribute_not_exists(pk)".into(), None),
        Some(id) => (
            "restaurant_id = :expected".into(),
            Some((":expected".into(), AttributeValue::S(id.clone()))),
        ),
    }
}

fn build_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable(format!("building request: {e}"))
}

impl DynamoStore {
    fn transact_items(&self, change: &Change) -> Result<Vec<TransactWriteItem>, StoreError> {
        let mut items = Vec::new();
        for t in &change.transitions {
            let r = &t.restaurant;
            let mut item = key(&restaurant_pk(&r.id), META);
            item.insert("data".into(), AttributeValue::S(to_json(r)?));
            if let Some(s) = r.status {
                item.insert("status".into(), AttributeValue::S(status_str(s).into()));
            }
            let mut put = Put::builder()
                .table_name(&self.table)
                .set_item(Some(item))
                .expression_attribute_names("#s", "status");
            put = match t.expected_status {
                None => put.condition_expression("attribute_not_exists(#s)"),
                Some(s) => put
                    .condition_expression("#s = :expected_status")
                    .expression_attribute_values(
                        ":expected_status",
                        AttributeValue::S(status_str(s).into()),
                    ),
            };
            items.push(
                TransactWriteItem::builder()
                    .put(put.build().map_err(build_err)?)
                    .build(),
            );

            let mut log = key(LOG_PK, &log_key(&t.log));
            log.insert("data".into(), AttributeValue::S(to_json(&t.log)?));
            items.push(
                TransactWriteItem::builder()
                    .put(
                        Put::builder()
                            .table_name(&self.table)
                            .set_item(Some(log))
                            .build()
                            .map_err(build_err)?,
                    )
                    .build(),
            );

            if t.country_visited {
                let at = AttributeValue::S(t.log.at.to_rfc3339());
                let update = Update::builder()
                    .table_name(&self.table)
                    .set_key(Some(key(COUNTRY_PK, &t.log.country_iso)))
                    .update_expression(
                        "ADD visit_count :one \
                         SET last_visited_at = :at, \
                         first_visited_at = if_not_exists(first_visited_at, :at)",
                    )
                    .expression_attribute_values(":one", AttributeValue::N("1".into()))
                    .expression_attribute_values(":at", at)
                    .build()
                    .map_err(build_err)?;
                items.push(TransactWriteItem::builder().update(update).build());
            }
        }

        let state_key = key(STATE_PK, PICKED_SK);
        let item = match pointer_op(change) {
            PointerOp::Check { expected } => {
                let (cond, value) = pointer_condition(&expected);
                let b = ConditionCheck::builder()
                    .table_name(&self.table)
                    .set_key(Some(state_key))
                    .condition_expression(cond);
                let b = match value {
                    Some((k, v)) => b.expression_attribute_values(k, v),
                    None => b,
                };
                TransactWriteItem::builder()
                    .condition_check(b.build().map_err(build_err)?)
                    .build()
            }
            PointerOp::Set { expected, to } => {
                let (cond, value) = pointer_condition(&expected);
                let mut item = state_key;
                item.insert("restaurant_id".into(), AttributeValue::S(to));
                let b = Put::builder()
                    .table_name(&self.table)
                    .set_item(Some(item))
                    .condition_expression(cond);
                let b = match value {
                    Some((k, v)) => b.expression_attribute_values(k, v),
                    None => b,
                };
                TransactWriteItem::builder()
                    .put(b.build().map_err(build_err)?)
                    .build()
            }
            PointerOp::Clear { expected } => {
                let (cond, value) = pointer_condition(&Some(expected));
                let (k, v) = value.expect("Some has a value");
                let d = Delete::builder()
                    .table_name(&self.table)
                    .set_key(Some(state_key))
                    .condition_expression(cond)
                    .expression_attribute_values(k, v)
                    .build()
                    .map_err(build_err)?;
                TransactWriteItem::builder().delete(d).build()
            }
        };
        items.push(item);
        Ok(items)
    }
}

fn is_condition_failure(e: &SdkError<TransactWriteItemsError>) -> bool {
    match e {
        SdkError::ServiceError(se) => match se.err() {
            TransactWriteItemsError::TransactionCanceledException(tc) => tc
                .cancellation_reasons()
                .iter()
                .any(|r| r.code() == Some("ConditionalCheckFailed")),
            _ => false,
        },
        _ => false,
    }
}

fn ttl_from(created_at: DateTime<Utc>, ttl: Duration) -> Option<DateTime<Utc>> {
    Some(created_at + ttl)
}

impl VisitStore for DynamoStore {
    async fn get_restaurant(&self, id: &str) -> Result<Option<Restaurant>, StoreError> {
        self.get_data(&restaurant_pk(id), META).await
    }

    async fn currently_picked(&self) -> Result<Option<Restaurant>, StoreError> {
        let Some(item) = self.get_item(STATE_PK, PICKED_SK).await? else {
            return Ok(None);
        };
        let id = item
            .get("restaurant_id")
            .and_then(|v| v.as_s().ok())
            .ok_or_else(|| StoreError::Unavailable("PICKED pointer has no id".into()))?;
        self.get_restaurant(id).await
    }

    async fn apply(&self, change: Change) -> Result<(), StoreError> {
        let items = self.transact_items(&change)?;
        match self
            .client
            .transact_write_items()
            .set_transact_items(Some(items))
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if is_condition_failure(&e) => Err(StoreError::Conflict),
            Err(e) => Err(unavailable(aws_sdk_dynamodb::error::DisplayErrorContext(e))),
        }
    }

    async fn country_visits(&self) -> Result<Vec<CountryVisits>, StoreError> {
        let mut out = Vec::new();
        let mut start = None;
        loop {
            let resp = self
                .client
                .query()
                .table_name(&self.table)
                .key_condition_expression("pk = :pk")
                .expression_attribute_values(":pk", AttributeValue::S(COUNTRY_PK.into()))
                .set_exclusive_start_key(start)
                .consistent_read(true)
                .send()
                .await
                .map_err(unavailable)?;
            for item in resp.items() {
                out.push(country_from_item(item)?);
            }
            start = resp.last_evaluated_key;
            if start.is_none() {
                break;
            }
        }
        Ok(out)
    }

    async fn history(
        &self,
        cursor: Option<String>,
        limit: usize,
    ) -> Result<HistoryPage, StoreError> {
        let mut q = self
            .client
            .query()
            .table_name(&self.table)
            .scan_index_forward(false)
            .limit(i32::try_from(limit + 1).unwrap_or(i32::MAX))
            .consistent_read(true)
            .expression_attribute_values(":pk", AttributeValue::S(LOG_PK.into()));
        q = match cursor {
            Some(c) => q
                .key_condition_expression("pk = :pk AND sk < :cursor")
                .expression_attribute_values(":cursor", AttributeValue::S(c)),
            None => q.key_condition_expression("pk = :pk"),
        };
        let resp = q.send().await.map_err(unavailable)?;
        let items = resp.items();
        let has_more = items.len() > limit;
        let page = &items[..items.len().min(limit)];
        let entries = page
            .iter()
            .map(data::<domain::status::LogEntry>)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if has_more {
            page.last()
                .and_then(|i| i.get("sk"))
                .and_then(|v| v.as_s().ok())
                .cloned()
        } else {
            None
        };
        Ok(HistoryPage {
            entries,
            next_cursor,
        })
    }
}

fn country_from_item(item: &Item) -> Result<CountryVisits, StoreError> {
    let s = |k: &str| item.get(k).and_then(|v| v.as_s().ok()).cloned();
    let time = |k: &str| -> Result<Option<DateTime<Utc>>, StoreError> {
        s(k).map(|v| v.parse().map_err(unavailable)).transpose()
    };
    Ok(CountryVisits {
        iso2: s("sk").unwrap_or_default(),
        visit_count: item
            .get("visit_count")
            .and_then(|v| v.as_n().ok())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0),
        first_visited_at: time("first_visited_at")?,
        last_visited_at: time("last_visited_at")?,
    })
}

impl PickStore for DynamoStore {
    async fn get_pick(&self, pick_id: &str) -> Result<Option<PickSession>, StoreError> {
        self.get_data(&format!("PICK#{pick_id}"), META).await
    }

    async fn put_pick(&self, session: &PickSession) -> Result<(), StoreError> {
        self.put_data(
            &format!("PICK#{}", session.pick_id),
            META,
            session,
            ttl_from(session.created_at, PICK_TTL),
        )
        .await
    }
}

impl GuessCache for DynamoStore {
    async fn get_guess(
        &self,
        place_id: &str,
        prompt_version: u32,
    ) -> Result<Option<CachedGuess>, StoreError> {
        self.get_data(
            &format!("PLACE#{place_id}"),
            &format!("GUESS#v{prompt_version}"),
        )
        .await
    }

    async fn put_guess(&self, guess: &CachedGuess) -> Result<(), StoreError> {
        self.put_data(
            &format!("PLACE#{}", guess.guess.place_id),
            &format!("GUESS#v{}", guess.prompt_version),
            guess,
            ttl_from(guess.created_at, GUESS_TTL),
        )
        .await
    }
}

impl GeocodeCache for DynamoStore {
    async fn get_geocode(&self, key_: &str) -> Result<Option<CachedLocation>, StoreError> {
        self.get_data(&format!("GEOCODE#{key_}"), META).await
    }

    async fn put_geocode(&self, key_: &str, value: &CachedLocation) -> Result<(), StoreError> {
        self.put_data(
            &format!("GEOCODE#{key_}"),
            META,
            value,
            ttl_from(value.created_at, GEOCODE_TTL),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use domain::status::{self, Event};

    use super::*;
    use crate::contract::restaurant;

    fn now() -> DateTime<Utc> {
        "2026-09-21T10:00:00Z".parse().unwrap()
    }

    fn pick(id: &str) -> domain::status::Transition {
        status::apply(
            &restaurant(id, "JP"),
            Event::Pick {
                pick_id: "p".into(),
            },
            now(),
        )
        .unwrap()
    }

    #[test]
    fn pointer_set_on_pick() {
        let change = Change {
            transitions: vec![pick("a")],
            expected_picked: None,
        };
        assert_eq!(
            pointer_op(&change),
            PointerOp::Set {
                expected: None,
                to: "a".into()
            }
        );
    }

    #[test]
    fn pointer_cleared_on_skip() {
        let picked = pick("a").restaurant;
        let skip = status::apply(&picked, Event::Skip, now()).unwrap();
        let change = Change {
            transitions: vec![skip],
            expected_picked: Some("a".into()),
        };
        assert_eq!(
            pointer_op(&change),
            PointerOp::Clear {
                expected: "a".into()
            }
        );
    }

    #[test]
    fn pointer_checked_when_unchanged() {
        let visit = status::apply(&restaurant("b", "IT"), Event::Visit, now()).unwrap();
        let change = Change {
            transitions: vec![visit],
            expected_picked: Some("a".into()),
        };
        assert_eq!(
            pointer_op(&change),
            PointerOp::Check {
                expected: Some("a".into())
            }
        );
    }

    #[test]
    fn country_item_parses() {
        let mut item = key(COUNTRY_PK, "JP");
        item.insert("visit_count".into(), AttributeValue::N("3".into()));
        item.insert(
            "last_visited_at".into(),
            AttributeValue::S("2026-09-21T10:00:00+00:00".into()),
        );
        let c = country_from_item(&item).unwrap();
        assert_eq!(c.iso2, "JP");
        assert_eq!(c.visit_count, 3);
        assert_eq!(c.last_visited_at, Some(now()));
        assert_eq!(c.first_visited_at, None);
    }
}
