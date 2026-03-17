use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::search::{SearchResultRecord, hybrid_search_project, search_project};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPayload {
    pub project_id: String,
    pub query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResultRecord>,
}

#[tauri::command]
pub fn search_project_command(
    payload: SearchPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<SearchResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let results = search_project(&app_state.db, &payload.project_id, &payload.query)?;
    Ok(SearchResponse { results })
}

#[tauri::command]
pub fn hybrid_search_project_command(
    payload: SearchPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<SearchResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let results = hybrid_search_project(&app_state.db, &payload.project_id, &payload.query)?;
    Ok(SearchResponse { results })
}
