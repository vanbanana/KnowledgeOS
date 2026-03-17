use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::jobs::JobRecord;
use crate::services::project::{list_projects, ProjectRecord};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub app_name: String,
    pub data_dir: String,
    pub log_dir: String,
    pub projects: Vec<ProjectRecord>,
    pub jobs: Vec<JobRecord>,
}

#[tauri::command]
pub fn get_bootstrap_payload(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<BootstrapPayload, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let projects = list_projects(&app_state.db).map_err(|error| error.to_string())?;
    let jobs = crate::jobs::list_jobs(&app_state.db).map_err(|error| error.to_string())?;

    Ok(BootstrapPayload {
        app_name: app_state.config.app_name.clone(),
        data_dir: app_state.config.data_dir.to_string_lossy().into_owned(),
        log_dir: app_state.config.log_dir.to_string_lossy().into_owned(),
        projects,
        jobs,
    })
}

