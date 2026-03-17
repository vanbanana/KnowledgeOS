use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::import::{
    DocumentRecord, ImportErrorRecord, get_all_documents, import_files, list_documents,
};
use crate::services::project::get_project;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesPayload {
    pub project_id: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDocumentsPayload {
    pub project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesResponse {
    pub documents: Vec<DocumentRecord>,
    pub queued_job_ids: Vec<String>,
    pub errors: Vec<ImportErrorRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDocumentsResponse {
    pub documents: Vec<DocumentRecord>,
}

#[tauri::command]
pub fn import_files_command(
    payload: ImportFilesPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ImportFilesResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let project = get_project(&app_state.db, &payload.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let result = import_files(
        &app_state.db,
        Path::new(&project.root_path),
        &payload.project_id,
        &payload.paths,
    )?;

    Ok(ImportFilesResponse {
        documents: result.documents,
        queued_job_ids: result.queued_job_ids,
        errors: result.errors,
    })
}

#[tauri::command]
pub fn list_documents_command(
    payload: ListDocumentsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListDocumentsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let documents =
        list_documents(&app_state.db, &payload.project_id).map_err(|error| error.to_string())?;
    Ok(ListDocumentsResponse { documents })
}

pub fn list_all_documents_for_bootstrap(state: &AppState) -> Result<Vec<DocumentRecord>, String> {
    get_all_documents(&state.db).map_err(|error| error.to_string())
}
