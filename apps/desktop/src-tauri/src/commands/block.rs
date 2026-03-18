use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::block::{
    BlockRecord, delete_block, insert_note_block, list_blocks, update_block_metadata,
};
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
    pub is_favorite: Option<bool>,
    pub note: Option<String>,
    pub title: Option<String>,
    pub content_md: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertNoteBlockPayload {
    pub document_id: String,
    pub before_block_id: Option<String>,
    pub title: Option<String>,
    pub content_md: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBlockPayload {
    pub block_id: String,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertNoteBlockCommandResponse {
    pub block: BlockRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBlockCommandResponse {
    pub block_id: String,
    pub deleted: bool,
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
        payload.title.as_deref(),
        payload.content_md.as_deref(),
    )?;
    Ok(UpdateBlockCommandResponse { block })
}

#[tauri::command]
pub fn insert_note_block_command(
    payload: InsertNoteBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<InsertNoteBlockCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let block = insert_note_block(
        &app_state.db,
        &payload.document_id,
        payload.before_block_id.as_deref(),
        payload.title.as_deref(),
        &payload.content_md,
    )?;
    Ok(InsertNoteBlockCommandResponse { block })
}

#[tauri::command]
pub fn delete_block_command(
    payload: DeleteBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<DeleteBlockCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    delete_block(&app_state.db, &payload.block_id)?;
    Ok(DeleteBlockCommandResponse {
        block_id: payload.block_id,
        deleted: true,
    })
}
