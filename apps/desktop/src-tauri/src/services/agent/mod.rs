pub mod executor;
pub mod planner;
pub mod preview;
pub mod tools;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanStep {
    pub step_id: String,
    pub title: String,
    pub tool_name: String,
    pub reason: String,
    pub risk_level: String,
    pub arguments_json: String,
    #[serde(default)]
    pub target_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlan {
    pub goal: String,
    pub summary: String,
    pub requires_approval: bool,
    pub planner_version: String,
    pub model_name: String,
    #[serde(default)]
    pub steps: Vec<AgentPlanStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreviewItem {
    pub item_id: String,
    pub kind: String,
    pub label: String,
    pub target_ref: Option<String>,
    pub risk_level: String,
    pub before_summary: Option<String>,
    pub after_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreview {
    pub summary: String,
    #[serde(default)]
    pub impact_summary: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub items: Vec<AgentPreviewItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskRecord {
    pub task_id: String,
    pub project_id: String,
    pub task_text: String,
    pub task_type: Option<String>,
    pub status: String,
    pub plan_json: Option<String>,
    pub preview_json: Option<String>,
    pub approval_required: bool,
    pub execution_log_path: Option<String>,
    pub rollback_ref: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogRecord {
    pub log_id: String,
    pub task_id: String,
    pub level: String,
    pub message: String,
    pub created_at: String,
}

pub const AGENT_STATUS_DRAFTED: &str = "drafted";
pub const AGENT_STATUS_PLANNED: &str = "planned";
pub const AGENT_STATUS_AWAITING_APPROVAL: &str = "awaiting_approval";
pub const AGENT_STATUS_EXECUTING: &str = "executing";
pub const AGENT_STATUS_COMPLETED: &str = "completed";
pub const AGENT_STATUS_FAILED: &str = "failed";
pub const AGENT_STATUS_ROLLED_BACK: &str = "rolled_back";
pub const AGENT_STATUS_CANCELLED: &str = "cancelled";

pub fn is_valid_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        (AGENT_STATUS_DRAFTED, AGENT_STATUS_PLANNED)
            | (AGENT_STATUS_PLANNED, AGENT_STATUS_AWAITING_APPROVAL)
            | (AGENT_STATUS_PLANNED, AGENT_STATUS_EXECUTING)
            | (AGENT_STATUS_AWAITING_APPROVAL, AGENT_STATUS_EXECUTING)
            | (AGENT_STATUS_AWAITING_APPROVAL, AGENT_STATUS_CANCELLED)
            | (AGENT_STATUS_EXECUTING, AGENT_STATUS_COMPLETED)
            | (AGENT_STATUS_EXECUTING, AGENT_STATUS_FAILED)
            | (AGENT_STATUS_COMPLETED, AGENT_STATUS_ROLLED_BACK)
            | (AGENT_STATUS_FAILED, AGENT_STATUS_CANCELLED)
    )
}

pub fn create_agent_task(
    connection: &Connection,
    project_id: &str,
    task_text: &str,
    task_type: Option<&str>,
) -> Result<AgentTaskRecord, String> {
    let task_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO agent_tasks (
                task_id, project_id, task_text, task_type, status, plan_json, preview_json,
                approval_required, execution_log_path, rollback_ref, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 1, NULL, NULL, ?6, ?7)",
            params![
                task_id,
                project_id,
                task_text,
                task_type,
                AGENT_STATUS_DRAFTED,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get_agent_task(connection, &task_id)?.ok_or_else(|| "创建 Agent 任务失败".to_string())
}

pub fn get_agent_task(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<AgentTaskRecord>, String> {
    connection
        .prepare(
            "SELECT task_id, project_id, task_text, task_type, status, plan_json, preview_json,
                    approval_required, execution_log_path, rollback_ref, created_at, updated_at
             FROM agent_tasks
             WHERE task_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([task_id], map_agent_task_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_agent_tasks(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<AgentTaskRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT task_id, project_id, task_text, task_type, status, plan_json, preview_json,
                    approval_required, execution_log_path, rollback_ref, created_at, updated_at
             FROM agent_tasks
             WHERE project_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], map_agent_task_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn save_agent_plan(
    connection: &Connection,
    task_id: &str,
    plan: &AgentPlan,
) -> Result<AgentTaskRecord, String> {
    let current =
        get_agent_task(connection, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    if !is_valid_transition(&current.status, AGENT_STATUS_PLANNED) {
        return Err("当前任务状态不能写入 plan".to_string());
    }
    let next_status = if plan.requires_approval {
        AGENT_STATUS_AWAITING_APPROVAL
    } else {
        AGENT_STATUS_PLANNED
    };
    let plan_json = serde_json::to_string(plan).map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE agent_tasks
             SET status = ?1, plan_json = ?2, approval_required = ?3, updated_at = ?4
             WHERE task_id = ?5",
            params![
                next_status,
                plan_json,
                if plan.requires_approval { 1 } else { 0 },
                now,
                task_id
            ],
        )
        .map_err(|error| error.to_string())?;
    get_agent_task(connection, task_id)?.ok_or_else(|| "更新 Agent 任务失败".to_string())
}

pub fn save_agent_preview(
    connection: &Connection,
    task_id: &str,
    preview: &AgentPreview,
) -> Result<AgentTaskRecord, String> {
    let preview_json = serde_json::to_string(preview).map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE agent_tasks
             SET preview_json = ?1, updated_at = ?2
             WHERE task_id = ?3",
            params![preview_json, now, task_id],
        )
        .map_err(|error| error.to_string())?;
    get_agent_task(connection, task_id)?.ok_or_else(|| "更新 Agent 任务预览失败".to_string())
}

pub fn transition_agent_task_status(
    connection: &Connection,
    task_id: &str,
    next_status: &str,
) -> Result<AgentTaskRecord, String> {
    let current =
        get_agent_task(connection, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    if current.status != next_status && !is_valid_transition(&current.status, next_status) {
        return Err(format!(
            "不允许从 {} 变更到 {}",
            current.status, next_status
        ));
    }
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE agent_tasks SET status = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![next_status, now, task_id],
        )
        .map_err(|error| error.to_string())?;
    get_agent_task(connection, task_id)?.ok_or_else(|| "更新 Agent 任务状态失败".to_string())
}

pub fn set_agent_task_rollback_ref(
    connection: &Connection,
    task_id: &str,
    rollback_ref: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE agent_tasks SET rollback_ref = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![rollback_ref, now, task_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn append_task_log(
    connection: &Connection,
    task_id: &str,
    level: &str,
    message: &str,
) -> Result<TaskLogRecord, String> {
    let log_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO task_logs (log_id, task_id, level, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![log_id, task_id, level, message, created_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(TaskLogRecord {
        log_id,
        task_id: task_id.to_string(),
        level: level.to_string(),
        message: message.to_string(),
        created_at,
    })
}

pub fn list_task_logs(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskLogRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT log_id, task_id, level, message, created_at
             FROM task_logs
             WHERE task_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok(TaskLogRecord {
                log_id: row.get(0)?,
                task_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn parse_agent_plan(task: &AgentTaskRecord) -> Result<AgentPlan, String> {
    serde_json::from_str(
        task.plan_json
            .as_deref()
            .ok_or_else(|| "当前任务还没有 plan".to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn map_agent_task_row(row: &rusqlite::Row<'_>) -> Result<AgentTaskRecord, rusqlite::Error> {
    Ok(AgentTaskRecord {
        task_id: row.get(0)?,
        project_id: row.get(1)?,
        task_text: row.get(2)?,
        task_type: row.get(3)?,
        status: row.get(4)?,
        plan_json: row.get(5)?,
        preview_json: row.get(6)?,
        approval_required: row.get::<_, i64>(7)? != 0,
        execution_log_path: row.get(8)?,
        rollback_ref: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
