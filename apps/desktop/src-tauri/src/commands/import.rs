use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::db::initialize_database;
use crate::services::import::{
    DocumentRecord, ImportErrorRecord, cleanup_unreadable_documents, delete_document,
    get_all_documents, get_document, import_files, list_documents,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentParseProgressPayload {
    pub document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPdfBytesPayload {
    pub document_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentParseProgress {
    pub phase: String,
    pub message: Option<String>,
    pub current_page: Option<i64>,
    pub total_pages: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentParseProgressResponse {
    pub progress: Option<DocumentParseProgress>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPdfBytesResponse {
    pub base64_data: String,
    pub byte_len: usize,
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
        let connection = initialize_database(&config.database_path, &config.migrations_dir)
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

#[tauri::command]
pub fn get_document_parse_progress_command(
    payload: DocumentParseProgressPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<DocumentParseProgressResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let progress_path = app_state
        .config
        .data_dir
        .join("progress")
        .join(format!("{}.json", payload.document_id));
    if !progress_path.exists() {
        return Ok(DocumentParseProgressResponse { progress: None });
    }

    let raw = std::fs::read_to_string(progress_path).map_err(|error| error.to_string())?;
    let progress = serde_json::from_str::<DocumentParseProgress>(&raw).ok();
    Ok(DocumentParseProgressResponse { progress })
}

#[tauri::command]
pub fn get_document_pdf_bytes_command(
    payload: DocumentPdfBytesPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<DocumentPdfBytesResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let document = get_document(&app_state.db, &payload.document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;

    if !document.source_type.eq_ignore_ascii_case("pdf") {
        return Err("当前文档不是 PDF".to_string());
    }

    let source_path = document.source_path.trim_start_matches(r"\\?\");
    let source = Path::new(source_path);
    if !source.exists() {
        return Err("PDF 源文件不存在".to_string());
    }

    let bytes = std::fs::read(source).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(DocumentPdfBytesResponse {
        base64_data: encoded,
        byte_len: bytes.len(),
    })
}
