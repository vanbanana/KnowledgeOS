use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::graph::query::{SubgraphFilters, SubgraphRecord, get_subgraph};
use crate::services::graph::suggest::suggest_relations_for_card;
use crate::services::graph::{
    GraphRelationRecord, RelationSuggestionRecord, UpsertRelationInput, confirm_relation,
    remove_relation, upsert_relation,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSubgraphPayload {
    pub project_id: String,
    #[serde(default)]
    pub node_types: Vec<String>,
    pub query_text: Option<String>,
    pub relation_confirmed_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRelationsPayload {
    pub card_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRelationPayload {
    pub project_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub relation_type: String,
    pub confidence: Option<f64>,
    pub origin_type: Option<String>,
    pub source_ref: Option<String>,
    pub confirmed_by_user: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationIdPayload {
    pub relation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSubgraphResponse {
    pub subgraph: SubgraphRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRelationsResponse {
    pub suggestions: Vec<RelationSuggestionRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationCommandResponse {
    pub relation: GraphRelationRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRelationResponse {
    pub removed: bool,
}

#[tauri::command]
pub fn get_subgraph_command(
    payload: GetSubgraphPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<GetSubgraphResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let subgraph = get_subgraph(
        &app_state.db,
        &SubgraphFilters {
            project_id: payload.project_id,
            node_types: payload.node_types,
            query_text: payload.query_text,
            relation_confirmed_only: payload.relation_confirmed_only.unwrap_or(false),
        },
    )?;
    Ok(GetSubgraphResponse { subgraph })
}

#[tauri::command]
pub fn suggest_relations_command(
    payload: SuggestRelationsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<SuggestRelationsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let suggestions = suggest_relations_for_card(&app_state.db, &payload.card_id)?;
    Ok(SuggestRelationsResponse { suggestions })
}

#[tauri::command]
pub fn upsert_relation_command(
    payload: UpsertRelationPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<RelationCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let relation = upsert_relation(
        &app_state.db,
        UpsertRelationInput {
            project_id: &payload.project_id,
            from_node_id: &payload.from_node_id,
            to_node_id: &payload.to_node_id,
            relation_type: &payload.relation_type,
            confidence: payload.confidence,
            origin_type: payload.origin_type.as_deref().unwrap_or("manual"),
            source_ref: payload.source_ref.as_deref(),
            confirmed_by_user: payload.confirmed_by_user.unwrap_or(true),
        },
    )?;
    Ok(RelationCommandResponse { relation })
}

#[tauri::command]
pub fn confirm_relation_command(
    payload: RelationIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<RelationCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let relation = confirm_relation(&app_state.db, &payload.relation_id)?;
    Ok(RelationCommandResponse { relation })
}

#[tauri::command]
pub fn remove_relation_command(
    payload: RelationIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<RemoveRelationResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    remove_relation(&app_state.db, &payload.relation_id)?;
    Ok(RemoveRelationResponse { removed: true })
}
