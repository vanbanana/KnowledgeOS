use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::card::{
    CardRecord, SaveCardInput, list_cards, save_card, save_card_from_block, update_card,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCardPayload {
    pub project_id: Option<String>,
    pub source_block_id: Option<String>,
    pub source_explanation_id: Option<String>,
    pub title: Option<String>,
    pub content_md: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCardsPayload {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardPayload {
    pub card_id: String,
    pub title: String,
    pub content_md: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCommandResponse {
    pub card: CardRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCardsResponse {
    pub cards: Vec<CardRecord>,
}

#[tauri::command]
pub fn save_card_command(
    payload: SaveCardPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<CardCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let card = if let Some(block_id) = payload.source_block_id.as_deref() {
        save_card_from_block(
            &app_state.db,
            block_id,
            payload.title.as_deref(),
            payload.tags,
        )?
    } else {
        save_card(
            &app_state.db,
            SaveCardInput {
                project_id: payload
                    .project_id
                    .ok_or_else(|| "缺少 projectId".to_string())?,
                source_block_id: None,
                source_explanation_id: payload.source_explanation_id,
                title: payload.title.ok_or_else(|| "缺少卡片标题".to_string())?,
                content_md: payload
                    .content_md
                    .ok_or_else(|| "缺少卡片内容".to_string())?,
                tags: payload.tags,
            },
        )?
    };
    Ok(CardCommandResponse { card })
}

#[tauri::command]
pub fn list_cards_command(
    payload: ListCardsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListCardsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let cards = list_cards(&app_state.db, &payload.project_id)?;
    Ok(ListCardsResponse { cards })
}

#[tauri::command]
pub fn update_card_command(
    payload: UpdateCardPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<CardCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let card = update_card(
        &app_state.db,
        &payload.card_id,
        &payload.title,
        &payload.content_md,
        payload.tags,
    )?;
    Ok(CardCommandResponse { card })
}
