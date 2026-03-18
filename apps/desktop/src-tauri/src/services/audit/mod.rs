use serde::Serialize;
use serde_json::Value;

use crate::services::agent::{AgentTaskRecord, TaskLogRecord, get_agent_task, list_task_logs};
use crate::services::snapshot::{SnapshotRecord, list_snapshots_by_task};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditDiffEntry {
    pub snapshot_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub label: String,
    pub before_text: Option<String>,
    pub after_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuditRecord {
    pub task: AgentTaskRecord,
    pub logs: Vec<TaskLogRecord>,
    pub snapshots: Vec<SnapshotRecord>,
    pub diffs: Vec<AuditDiffEntry>,
}

pub fn get_agent_audit(app_state: &AppState, task_id: &str) -> Result<AgentAuditRecord, String> {
    let task = get_agent_task(&app_state.db, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    let logs = list_task_logs(&app_state.db, task_id)?;
    let snapshots = list_snapshots_by_task(&app_state.db, task_id)?;
    let diffs = snapshots.iter().map(build_diff_entry).collect::<Result<Vec<_>, _>>()?;
    Ok(AgentAuditRecord {
        task,
        logs,
        snapshots,
        diffs,
    })
}

fn build_diff_entry(snapshot: &SnapshotRecord) -> Result<AuditDiffEntry, String> {
    let payload: Value = serde_json::from_str(&snapshot.snapshot_json).map_err(|error| error.to_string())?;
    let before_text = payload
        .get("record")
        .and_then(render_record_summary)
        .or_else(|| {
            if payload.get("kind").and_then(Value::as_str) == Some("file") {
                Some("文件内容已生成快照".to_string())
            } else {
                None
            }
        });
    let label = format!("{} / {}", snapshot.entity_type, snapshot.entity_id);
    Ok(AuditDiffEntry {
        snapshot_id: snapshot.snapshot_id.clone(),
        entity_type: snapshot.entity_type.clone(),
        entity_id: snapshot.entity_id.clone(),
        label,
        before_text,
        after_text: None,
    })
}

fn render_record_summary(value: &Value) -> Option<String> {
    if value.is_null() {
        return Some("原状态为空".to_string());
    }
    if let Some(text) = value.get("contentMd").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("content_md").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("title").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    Some(value.to_string())
}
