use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::jobs::{JobRecord, enqueue_job, list_jobs as query_jobs};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueMockJobPayload {
    pub kind: String,
    pub payload: Option<Value>,
    pub max_attempts: Option<i64>,
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
