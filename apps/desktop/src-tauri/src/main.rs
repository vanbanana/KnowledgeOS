#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod db;
mod fs;
mod jobs;
mod logging;
mod services;
mod state;

use std::sync::{Arc, Mutex};

use commands::app::get_bootstrap_payload;
use commands::import::{import_files_command, list_documents_command};
use commands::jobs::{enqueue_mock_job, list_jobs};
use commands::project::{create_project, list_projects};
use state::AppState;

fn main() {
    let app_state = AppState::bootstrap().expect("应用状态初始化失败");
    let managed_state = Arc::new(Mutex::new(app_state));

    tauri::Builder::default()
        .manage(managed_state)
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_payload,
            create_project,
            list_projects,
            import_files_command,
            list_documents_command,
            enqueue_mock_job,
            list_jobs
        ])
        .run(tauri::generate_context!())
        .expect("运行 KnowledgeOS 失败");
}
