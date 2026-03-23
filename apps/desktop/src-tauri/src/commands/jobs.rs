use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::initialize_database;
use crate::jobs::{
    JobRecord, cancel_job, enqueue_job, list_jobs as query_jobs, retry_job, run_job,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueMockJobPayload {
    pub kind: String,
    pub payload: Option<Value>,
    pub max_attempts: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCommandPayload {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueMockJobResponse {
    pub job: JobRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListJobsResponse {
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCommandResponse {
    pub job: JobRecord,
}

#[tauri::command]
pub fn enqueue_mock_job(
    payload: EnqueueMockJobPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<EnqueueMockJobResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let payload_json = payload
        .payload
        .map(|value| value.to_string())
        .unwrap_or_else(|| "{}".to_string());

    let job = enqueue_job(
        &app_state.db,
        payload.kind.trim(),
        &payload_json,
        payload.max_attempts.unwrap_or(3),
    )
    .map_err(|error| error.to_string())?;

    Ok(EnqueueMockJobResponse { job })
}

#[tauri::command]
pub fn list_jobs(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListJobsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let jobs = query_jobs(&app_state.db).map_err(|error| error.to_string())?;
    Ok(ListJobsResponse { jobs })
}

#[tauri::command]
pub async fn run_job_command(
    payload: JobCommandPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<JobCommandResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let job_id = payload.job_id.clone();
    let job = tauri::async_runtime::spawn_blocking(move || {
        let migrations_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection = initialize_database(&config.database_path, &migrations_dir)
            .map_err(|error| error.to_string())?;
        run_job(&connection, &config, &job_id)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(JobCommandResponse { job })
}

#[tauri::command]
pub fn retry_job_command(
    payload: JobCommandPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<JobCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let job = retry_job(&app_state.db, &payload.job_id)?;
    Ok(JobCommandResponse { job })
}

#[tauri::command]
pub fn cancel_job_command(
    payload: JobCommandPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<JobCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let job = cancel_job(&app_state.db, &payload.job_id)?;
    Ok(JobCommandResponse { job })
}
