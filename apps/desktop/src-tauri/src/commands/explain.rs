use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::ai::model_adapter::build_model_adapter;
use crate::db::initialize_database;
use crate::services::explain::{
    BlockExplanationRecord, ExplainTemplateRecord, explain_block, list_block_explanations,
    list_document_block_explanations, list_explain_templates, regenerate_block_explanation,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainBlockPayload {
    pub block_id: String,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBlockExplanationsPayload {
    pub block_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDocumentBlockExplanationsPayload {
    pub document_id: String,
    pub mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainBlockResponse {
    pub explanation: BlockExplanationRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBlockExplanationsResponse {
    pub explanations: Vec<BlockExplanationRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDocumentBlockExplanationsResponse {
    pub explanations: Vec<BlockExplanationRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListExplainTemplatesResponse {
    pub templates: Vec<ExplainTemplateRecord>,
}

#[tauri::command]
pub async fn explain_block_command(
    payload: ExplainBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ExplainBlockResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let block_id = payload.block_id.clone();
    let mode = payload.mode.unwrap_or_else(|| "default".to_string());
    let explanation = tauri::async_runtime::spawn_blocking(move || {
        let adapter = build_model_adapter(&config.model_settings)?;
        let migrations_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection = initialize_database(&config.database_path, &migrations_dir)
            .map_err(|error| error.to_string())?;
        explain_block(
            &connection,
            &block_id,
            &mode,
            adapter.as_ref(),
            &config.model_settings.provider,
            &config.model_settings.tool_model,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(ExplainBlockResponse { explanation })
}

#[tauri::command]
pub async fn regenerate_block_explanation_command(
    payload: ExplainBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ExplainBlockResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let block_id = payload.block_id.clone();
    let mode = payload.mode.unwrap_or_else(|| "default".to_string());
    let explanation = tauri::async_runtime::spawn_blocking(move || {
        let adapter = build_model_adapter(&config.model_settings)?;
        let migrations_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection = initialize_database(&config.database_path, &migrations_dir)
            .map_err(|error| error.to_string())?;
        regenerate_block_explanation(
            &connection,
            &block_id,
            &mode,
            adapter.as_ref(),
            &config.model_settings.provider,
            &config.model_settings.tool_model,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(ExplainBlockResponse { explanation })
}

#[tauri::command]
pub fn list_block_explanations_command(
    payload: ListBlockExplanationsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListBlockExplanationsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let explanations = list_block_explanations(&app_state.db, &payload.block_id)?;
    Ok(ListBlockExplanationsResponse { explanations })
}

#[tauri::command]
pub fn list_document_block_explanations_command(
    payload: ListDocumentBlockExplanationsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListDocumentBlockExplanationsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let explanations = list_document_block_explanations(
        &app_state.db,
        &payload.document_id,
        payload.mode.as_deref(),
    )?;
    Ok(ListDocumentBlockExplanationsResponse { explanations })
}

#[tauri::command]
pub fn list_explain_templates_command(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListExplainTemplatesResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let templates = list_explain_templates(&app_state.db)?;
    Ok(ListExplainTemplatesResponse { templates })
}
