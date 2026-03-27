use std::fs;
use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::services::agent::{
    AGENT_STATUS_ROLLED_BACK, AgentTaskRecord, append_task_log, set_agent_task_rollback_ref,
    transition_agent_task_status,
};
use crate::services::snapshot::{SnapshotRecord, list_snapshots_by_task};
use crate::state::AppState;

pub fn rollback_task(
    app_state: &AppState,
    task_id: &str,
) -> Result<(AgentTaskRecord, Vec<SnapshotRecord>), String> {
    let snapshots = list_snapshots_by_task(&app_state.db, task_id)?;
    if snapshots.is_empty() {
        return Err("当前任务没有可回滚快照".to_string());
    }

    for snapshot in &snapshots {
        restore_snapshot(&app_state.db, snapshot)?;
    }

    set_agent_task_rollback_ref(&app_state.db, task_id, Some(task_id))?;
    append_task_log(&app_state.db, task_id, "info", "已完成回滚")?;
    let task = transition_agent_task_status(&app_state.db, task_id, AGENT_STATUS_ROLLED_BACK)?;
    Ok((task, snapshots))
}

fn restore_snapshot(connection: &Connection, snapshot: &SnapshotRecord) -> Result<(), String> {
    let payload: Value =
        serde_json::from_str(&snapshot.snapshot_json).map_err(|error| error.to_string())?;
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("record");
    if kind == "file" {
        restore_file_snapshot(snapshot, &payload)?;
        return Ok(());
    }

    let record = payload.get("record").cloned().unwrap_or(Value::Null);
    match snapshot.entity_type.as_str() {
        "document" => restore_document(connection, snapshot, &record),
        "block" => restore_block(connection, snapshot, &record),
        "card" => restore_card(connection, snapshot, &record),
        "relation" => restore_relation(connection, snapshot, &record),
        _ => Ok(()),
    }
}

fn restore_file_snapshot(snapshot: &SnapshotRecord, payload: &Value) -> Result<(), String> {
    let Some(file_path) = snapshot.file_path.as_deref() else {
        return Ok(());
    };
    let exists_before = payload
        .get("existsBefore")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target = Path::new(file_path);
    if !exists_before {
        if target.exists() {
            fs::remove_file(target).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let backup_path = payload
        .get("backupPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "文件快照缺少 backupPath".to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(backup_path, target).map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_document(
    connection: &Connection,
    snapshot: &SnapshotRecord,
    record: &Value,
) -> Result<(), String> {
    if record.is_null() {
        connection
            .execute(
                "DELETE FROM documents WHERE document_id = ?1",
                [snapshot.entity_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    connection
        .execute(
            "INSERT OR REPLACE INTO documents (
                document_id, project_id, source_path, source_type, source_hash, normalized_md_path,
                manifest_path, title, parse_status, imported_at, updated_at, last_error_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                record.get("documentId").and_then(Value::as_str),
                record.get("projectId").and_then(Value::as_str),
                record.get("sourcePath").and_then(Value::as_str),
                record.get("sourceType").and_then(Value::as_str),
                record.get("sourceHash").and_then(Value::as_str),
                record.get("normalizedMdPath").and_then(Value::as_str),
                record.get("manifestPath").and_then(Value::as_str),
                record.get("title").and_then(Value::as_str),
                record.get("parseStatus").and_then(Value::as_str),
                record.get("importedAt").and_then(Value::as_str),
                record.get("updatedAt").and_then(Value::as_str),
                record.get("lastErrorMessage").and_then(Value::as_str)
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_block(
    connection: &Connection,
    snapshot: &SnapshotRecord,
    record: &Value,
) -> Result<(), String> {
    if record.is_null() {
        connection
            .execute(
                "DELETE FROM blocks WHERE block_id = ?1",
                [snapshot.entity_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    connection
        .execute(
            "INSERT OR REPLACE INTO blocks (
                block_id, project_id, document_id, block_type, title, heading_path, depth, order_index,
                content_md, token_count, source_anchor, parent_block_id, is_favorite, note, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                record.get("blockId").and_then(Value::as_str),
                record.get("projectId").and_then(Value::as_str),
                record.get("documentId").and_then(Value::as_str),
                record.get("blockType").and_then(Value::as_str),
                record.get("title").and_then(Value::as_str),
                record.get("headingPath").map(Value::to_string),
                record.get("depth").and_then(Value::as_i64),
                record.get("orderIndex").and_then(Value::as_i64),
                record.get("contentMd").and_then(Value::as_str),
                record.get("tokenCount").and_then(Value::as_i64),
                record.get("sourceAnchor").and_then(Value::as_str),
                record.get("parentBlockId").and_then(Value::as_str),
                if record.get("isFavorite").and_then(Value::as_bool).unwrap_or(false) { 1 } else { 0 },
                record.get("note").and_then(Value::as_str),
                record.get("createdAt").and_then(Value::as_str),
                record.get("updatedAt").and_then(Value::as_str)
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_card(
    connection: &Connection,
    snapshot: &SnapshotRecord,
    record: &Value,
) -> Result<(), String> {
    if record.is_null() {
        connection
            .execute(
                "DELETE FROM cards WHERE card_id = ?1",
                [snapshot.entity_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    connection
        .execute(
            "INSERT OR REPLACE INTO cards (
                card_id, project_id, source_block_id, source_explanation_id, title, content_md,
                tags_json, created_by, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                record.get("cardId").and_then(Value::as_str),
                record.get("projectId").and_then(Value::as_str),
                record.get("sourceBlockId").and_then(Value::as_str),
                record.get("sourceExplanationId").and_then(Value::as_str),
                record.get("title").and_then(Value::as_str),
                record.get("contentMd").and_then(Value::as_str),
                record.get("tagsJson").and_then(Value::as_str),
                record.get("createdBy").and_then(Value::as_str),
                record.get("createdAt").and_then(Value::as_str),
                record.get("updatedAt").and_then(Value::as_str)
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_relation(
    connection: &Connection,
    snapshot: &SnapshotRecord,
    record: &Value,
) -> Result<(), String> {
    if record.is_null() {
        connection
            .execute(
                "DELETE FROM graph_relations WHERE relation_id = ?1",
                [snapshot.entity_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    connection
        .execute(
            "INSERT OR REPLACE INTO graph_relations (
                relation_id, project_id, from_node_id, to_node_id, relation_type, confidence,
                origin_type, source_ref, confirmed_by_user, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                record.get("relationId").and_then(Value::as_str),
                record.get("projectId").and_then(Value::as_str),
                record.get("fromNodeId").and_then(Value::as_str),
                record.get("toNodeId").and_then(Value::as_str),
                record.get("relationType").and_then(Value::as_str),
                record.get("confidence").and_then(Value::as_f64),
                record.get("originType").and_then(Value::as_str),
                record.get("sourceRef").and_then(Value::as_str),
                if record
                    .get("confirmedByUser")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    1
                } else {
                    0
                },
                record.get("createdAt").and_then(Value::as_str)
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
