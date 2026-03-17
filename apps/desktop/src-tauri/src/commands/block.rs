use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::block::{BlockRecord, list_blocks, update_block_metadata};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBlocksPayload {
    pub document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBlockPayload {
    pub block_id: String,
    pub is_favorite: bool,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBlocksCommandResponse {
    pub blocks: Vec<BlockRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBlockCommandResponse {
    pub block: BlockRecord,
}

#[tauri::command]
pub fn list_blocks_command(
    payload: ListBlocksPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListBlocksCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let blocks =
        list_blocks(&app_state.db, &payload.document_id).map_err(|error| error.to_string())?;
    Ok(ListBlocksCommandResponse { blocks })
}

#[tauri::command]
pub fn update_block_command(
    payload: UpdateBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<UpdateBlockCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let block = update_block_metadata(
        &app_state.db,
        &payload.block_id,
        payload.is_favorite,
        payload.note.as_deref(),
    )?;
    Ok(UpdateBlockCommandResponse { block })
}
