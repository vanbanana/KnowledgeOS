use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::chunk::{SourcePreview, get_source_preview};
use crate::services::reader_state::{ReaderStateRecord, upsert_reader_state};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertReaderStatePayload {
    pub project_id: String,
    pub document_id: String,
    pub block_id: String,
    pub source_anchor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreviewPayload {
    pub document_id: String,
    pub anchor: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStateCommandResponse {
    pub reader_state: ReaderStateRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreviewCommandResponse {
    pub preview: SourcePreview,
}

#[tauri::command]
pub fn upsert_reader_state_command(
    payload: UpsertReaderStatePayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ReaderStateCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let reader_state = upsert_reader_state(
        &app_state.db,
        &payload.project_id,
        &payload.document_id,
        &payload.block_id,
        payload.source_anchor.as_deref(),
    )?;
    Ok(ReaderStateCommandResponse { reader_state })
}

#[tauri::command]
pub fn get_source_preview_command(
    payload: SourcePreviewPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<SourcePreviewCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let preview = get_source_preview(&app_state.db, &payload.document_id, &payload.anchor)?;
    Ok(SourcePreviewCommandResponse { preview })
}
