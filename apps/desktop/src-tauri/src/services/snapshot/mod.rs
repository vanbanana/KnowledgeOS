use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::services::import::get_document;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub snapshot_id: String,
    pub task_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub file_path: Option<String>,
    pub content_hash: Option<String>,
    pub snapshot_json: String,
    pub created_at: String,
}

pub fn snapshot_storage_dir(config: &AppConfig) -> PathBuf {
    config.data_dir.join("snapshots")
}

pub fn ensure_snapshot_dir(config: &AppConfig) -> Result<PathBuf, String> {
    let dir = snapshot_storage_dir(config);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn create_file_snapshot(
    connection: &Connection,
    config: &AppConfig,
    task_id: &str,
    entity_type: &str,
    entity_id: &str,
    file_path: &Path,
) -> Result<SnapshotRecord, String> {
    let storage_dir = ensure_snapshot_dir(config)?;
    let backup_path = storage_dir.join(format!("{}.bak", Uuid::new_v4()));
    let (exists_before, content_hash, stored_backup_path) = if file_path.exists() {
        fs::copy(file_path, &backup_path).map_err(|error| error.to_string())?;
        let bytes = fs::read(file_path).map_err(|error| error.to_string())?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        (
            true,
            Some(hash),
            Some(backup_path.to_string_lossy().into_owned()),
        )
    } else {
        (false, None, None)
    };
    let snapshot_json = serde_json::json!({
        "kind": "file",
        "existsBefore": exists_before,
        "backupPath": stored_backup_path
    });
    create_snapshot_record(
        connection,
        Some(task_id),
        entity_type,
        entity_id,
        Some(file_path.to_string_lossy().into_owned()),
        content_hash,
        snapshot_json,
    )
}

pub fn create_record_snapshot<T: Serialize>(
    connection: &Connection,
    task_id: &str,
    entity_type: &str,
    entity_id: &str,
    record: Option<&T>,
) -> Result<SnapshotRecord, String> {
    let snapshot_json = serde_json::json!({
        "kind": "record",
        "record": record
    });
    create_snapshot_record(
        connection,
        Some(task_id),
        entity_type,
        entity_id,
        None,
        None,
        snapshot_json,
    )
}

pub fn snapshot_document(
    connection: &Connection,
    task_id: &str,
    document_id: &str,
) -> Result<SnapshotRecord, String> {
    let document = get_document(connection, document_id).map_err(|error| error.to_string())?;
    create_record_snapshot(
        connection,
        task_id,
        "document",
        document_id,
        document.as_ref(),
    )
}

pub fn create_snapshot_record(
    connection: &Connection,
    task_id: Option<&str>,
    entity_type: &str,
    entity_id: &str,
    file_path: Option<String>,
    content_hash: Option<String>,
    snapshot_json: Value,
) -> Result<SnapshotRecord, String> {
    let snapshot_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let snapshot_json = snapshot_json.to_string();
    connection
        .execute(
            "INSERT INTO snapshots (snapshot_id, task_id, entity_type, entity_id, file_path, content_hash, snapshot_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                snapshot_id,
                task_id,
                entity_type,
                entity_id,
                file_path,
                content_hash,
                snapshot_json,
                created_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(SnapshotRecord {
        snapshot_id,
        task_id: task_id.map(|value| value.to_string()),
        entity_type: entity_type.to_string(),
        entity_id: entity_id.to_string(),
        file_path,
        content_hash,
        snapshot_json,
        created_at,
    })
}

pub fn list_snapshots_by_task(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<SnapshotRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT snapshot_id, task_id, entity_type, entity_id, file_path, content_hash, snapshot_json, created_at
             FROM snapshots
             WHERE task_id = ?1
             ORDER BY created_at DESC, snapshot_id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok(SnapshotRecord {
                snapshot_id: row.get(0)?,
                task_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                file_path: row.get(4)?,
                content_hash: row.get(5)?,
                snapshot_json: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[allow(dead_code)]
fn _assert_path(path: &Path) -> &Path {
    path
}
