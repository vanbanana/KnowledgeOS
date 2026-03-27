use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::ai::model_adapter::build_model_adapter;
use crate::db::initialize_database;
use crate::services::studio::{
    CreateStudioArtifactInput, StudioArtifactRecord, create_studio_artifact,
    generate_studio_artifact, get_studio_artifact, list_studio_artifacts,
    mark_studio_artifact_failed,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStudioArtifactPayload {
    pub project_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub source_document_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioArtifactIdPayload {
    pub artifact_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStudioArtifactsPayload {
    pub project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioArtifactCommandResponse {
    pub artifact: StudioArtifactRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStudioArtifactsResponse {
    pub artifacts: Vec<StudioArtifactRecord>,
}

#[tauri::command]
pub async fn create_studio_artifact_command(
    payload: CreateStudioArtifactPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<StudioArtifactCommandResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let result: StudioArtifactCommandResponse = tauri::async_runtime::spawn_blocking(move || {
        let connection = initialize_database(&config.database_path, &config.migrations_dir)
            .map_err(|error| error.to_string())?;
        let artifact = create_studio_artifact(
            &connection,
            CreateStudioArtifactInput {
                project_id: payload.project_id,
                kind: payload.kind,
                title: payload.title,
                source_document_ids: payload.source_document_ids,
            },
        )?;
        Ok::<StudioArtifactCommandResponse, String>(StudioArtifactCommandResponse { artifact })
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(result)
}

#[tauri::command]
pub async fn generate_studio_artifact_command(
    payload: StudioArtifactIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<StudioArtifactCommandResponse, String> {
    let config = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.clone()
    };
    let artifact_id = payload.artifact_id.clone();
    let result: StudioArtifactCommandResponse = tauri::async_runtime::spawn_blocking(move || {
        let connection = initialize_database(&config.database_path, &config.migrations_dir)
            .map_err(|error| error.to_string())?;
        let model_adapter = build_model_adapter(&config.model_settings)?;
        match generate_studio_artifact(&connection, &config, &artifact_id, model_adapter.as_ref()) {
            Ok(artifact) => Ok(StudioArtifactCommandResponse { artifact }),
            Err(error) => {
                let _ = mark_studio_artifact_failed(&connection, &artifact_id, &error);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(result)
}

#[tauri::command]
pub fn list_studio_artifacts_command(
    payload: ListStudioArtifactsPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListStudioArtifactsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let artifacts = list_studio_artifacts(&app_state.db, &payload.project_id)?;
    Ok(ListStudioArtifactsResponse { artifacts })
}

#[tauri::command]
pub fn get_studio_artifact_command(
    payload: StudioArtifactIdPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<StudioArtifactCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let artifact = get_studio_artifact(&app_state.db, &payload.artifact_id)?
        .ok_or_else(|| "Studio 产物不存在".to_string())?;
    Ok::<StudioArtifactCommandResponse, String>(StudioArtifactCommandResponse { artifact })
}
