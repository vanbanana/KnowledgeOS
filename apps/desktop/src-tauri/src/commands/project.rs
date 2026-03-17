use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::project::{
    create_project_record, initialize_project_directories, list_projects as query_projects, ProjectRecord,
};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectPayload {
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
pub fn list_projects(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ListProjectsResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let projects = query_projects(&app_state.db).map_err(|error| error.to_string())?;
    Ok(ListProjectsResponse { projects })
}

