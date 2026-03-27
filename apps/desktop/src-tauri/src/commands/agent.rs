use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::agent::executor::{confirm_and_execute, rollback_agent_task};
use crate::services::agent::planner::plan_agent_task;
use crate::services::agent::preview::generate_preview;
use crate::services::agent::{AgentPlan, AgentTaskRecord, TaskLogRecord, list_agent_tasks};
use crate::services::audit::{AgentAuditRecord, get_agent_audit};
use crate::services::snapshot::SnapshotRecord;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAgentTaskPayload {
    pub project_id: String,
    pub task_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskIdPayload {
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentTasksPayload {
    pub project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAgentTaskCommandResponse {
    pub task: AgentTaskRecord,
    pub plan: AgentPlan,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentTasksCommandResponse {
    pub tasks: Vec<AgentTaskRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskCommandResponse {
    pub task: AgentTaskRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateAgentPreviewCommandResponse {
    pub task: AgentTaskRecord,
    pub preview: crate::services::agent::AgentPreview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackAgentTaskCommandResponse {
    pub task: AgentTaskRecord,
    pub rolled_back: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentTaskLogsCommandResponse {
    pub logs: Vec<TaskLogRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentAuditCommandResponse {
    pub task: AgentTaskRecord,
    pub logs: Vec<TaskLogRecord>,
    pub snapshots: Vec<SnapshotRecord>,
    pub diffs: Vec<crate::services::audit::AuditDiffEntry>,
}

#[tauri::command]
pub async fn plan_agent_task_command(
    payload: PlanAgentTaskPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<PlanAgentTaskCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let (task, plan) = plan_agent_task(&app_state, &payload.project_id, &payload.task_text)?;
        Ok(PlanAgentTaskCommandResponse { task, plan })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_agent_tasks_command(
    payload: ListAgentTasksPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListAgentTasksCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let tasks = list_agent_tasks(&app_state.db, &payload.project_id)?;
        Ok(ListAgentTasksCommandResponse { tasks })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn generate_agent_preview_command(
    payload: AgentTaskIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<GenerateAgentPreviewCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let (task, preview) = generate_preview(&app_state, &payload.task_id)?;
        Ok(GenerateAgentPreviewCommandResponse { task, preview })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn confirm_agent_task_command(
    payload: AgentTaskIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<AgentTaskCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let task = confirm_and_execute(&app_state, &payload.task_id)?;
        Ok(AgentTaskCommandResponse { task })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rollback_agent_task_command(
    payload: AgentTaskIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<RollbackAgentTaskCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let task = rollback_agent_task(&app_state, &payload.task_id)?;
        Ok(RollbackAgentTaskCommandResponse {
            task,
            rolled_back: true,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_agent_task_logs_command(
    payload: AgentTaskIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListAgentTaskLogsCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let logs = crate::services::agent::list_task_logs(&app_state.db, &payload.task_id)?;
        Ok(ListAgentTaskLogsCommandResponse { logs })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_agent_audit_command(
    payload: AgentTaskIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<GetAgentAuditCommandResponse, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app_state = shared_state.lock().map_err(|error| error.to_string())?;
        let AgentAuditRecord {
            task,
            logs,
            snapshots,
            diffs,
        } = get_agent_audit(&app_state, &payload.task_id)?;
        Ok(GetAgentAuditCommandResponse {
            task,
            logs,
            snapshots,
            diffs,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
