use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::explain::{
    BlockExplanationRecord, ExplainTemplateRecord, explain_block, list_block_explanations,
    list_explain_templates, regenerate_block_explanation,
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
pub struct ListExplainTemplatesResponse {
    pub templates: Vec<ExplainTemplateRecord>,
}

#[tauri::command]
pub fn explain_block_command(
    payload: ExplainBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ExplainBlockResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let explanation = explain_block(
        &app_state.db,
        &payload.block_id,
        payload.mode.as_deref().unwrap_or("default"),
    )?;
    Ok(ExplainBlockResponse { explanation })
}

#[tauri::command]
pub fn regenerate_block_explanation_command(
    payload: ExplainBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ExplainBlockResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let explanation = regenerate_block_explanation(
        &app_state.db,
        &payload.block_id,
        payload.mode.as_deref().unwrap_or("default"),
    )?;
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
pub fn list_explain_templates_command(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListExplainTemplatesResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let templates = list_explain_templates(&app_state.db)?;
    Ok(ListExplainTemplatesResponse { templates })
}
