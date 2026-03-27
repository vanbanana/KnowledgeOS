use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::project::{
    ProjectRecord, create_project_record, delete_project as remove_project, get_project,
    initialize_project_directories, list_projects as query_projects,
    rename_project as update_project,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectPayload {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLookupPayload {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectPayload {
    pub project_id: String,
    pub delete_files: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectPayload {
    pub project_id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectResponse {
    pub project: ProjectRecord,
    pub initialized_directories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResponse {
    pub projects: Vec<ProjectRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResponse {
    pub project: ProjectRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectResponse {
    pub project: ProjectRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectResponse {
    pub project_id: String,
    pub deleted_files: bool,
}

#[tauri::command]
pub fn create_project(
    payload: CreateProjectPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<CreateProjectResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let project = create_project_record(
        &app_state.db,
        &app_state.config.projects_dir,
        payload.name.trim(),
        payload.description.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let initialized_directories =
        initialize_project_directories(&project.root_path).map_err(|error| error.to_string())?;

    Ok(CreateProjectResponse {
        project,
        initialized_directories,
    })
}

#[tauri::command]
pub fn open_project(
    payload: ProjectLookupPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<OpenProjectResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let project = get_project(&app_state.db, &payload.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    Ok(OpenProjectResponse { project })
}

#[tauri::command]
pub fn rename_project(
    payload: RenameProjectPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<RenameProjectResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let project = update_project(
        &app_state.db,
        &payload.project_id,
        payload.name.trim(),
        payload.description.as_deref(),
    )?
    .ok_or_else(|| "项目不存在".to_string())?;
    Ok(RenameProjectResponse { project })
}

#[tauri::command]
pub fn delete_project(
    payload: DeleteProjectPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<DeleteProjectResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let deleted_files = payload.delete_files.unwrap_or(true);
    let deleted = remove_project(&app_state.db, &payload.project_id, deleted_files)?;
    if deleted.is_none() {
        return Err("项目不存在".to_string());
    }

    Ok(DeleteProjectResponse {
        project_id: payload.project_id,
        deleted_files,
    })
}

#[tauri::command]
pub fn list_projects(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListProjectsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let projects = query_projects(&app_state.db).map_err(|error| error.to_string())?;
    Ok(ListProjectsResponse { projects })
}
