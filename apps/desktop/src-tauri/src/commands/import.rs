use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::db::initialize_database;
use crate::services::import::{
    DocumentRecord, ImportErrorRecord, cleanup_unreadable_documents, delete_document, get_all_documents, import_files,
    list_documents,
};
use crate::services::project::get_project;
use crate::services::search::rebuild_project_search_index;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDocumentPayload {
    pub document_id: String,
    pub delete_files: Option<bool>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDocumentResponse {
    pub document_id: String,
    pub deleted_files: bool,
}

#[tauri::command]
pub async fn import_files_command(
    payload: ImportFilesPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ImportFilesResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let project_id = payload.project_id.clone();
    let paths = payload.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let migrations_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection = initialize_database(&config.database_path, &migrations_dir)
            .map_err(|error| error.to_string())?;
        let project = get_project(&connection, &project_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?;
        import_files(
            &connection,
            Path::new(&project.root_path),
            &project_id,
            &paths,
        )
    })
    .await
    .map_err(|error| error.to_string())??;

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

#[tauri::command]
pub fn delete_document_command(
    payload: DeleteDocumentPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<DeleteDocumentResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let deleted_files = payload.delete_files.unwrap_or(true);
    let deleted = delete_document(&app_state.db, &payload.document_id, deleted_files)?;
    let Some(document) = deleted else {
        return Err("文档不存在".to_string());
    };
    rebuild_project_search_index(&app_state.db, &document.project_id)?;
    Ok(DeleteDocumentResponse {
        document_id: payload.document_id,
        deleted_files,
    })
}

pub fn list_all_documents_for_bootstrap(state: &AppState) -> Result<Vec<DocumentRecord>, String> {
    cleanup_unreadable_documents(&state.db)?;
    get_all_documents(&state.db).map_err(|error| error.to_string())
}
