#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod db;
mod fs;
mod jobs;
mod logging;
mod services;
mod sidecar;
mod state;

use std::sync::{Arc, Mutex};

use commands::app::get_bootstrap_payload;
use commands::block::{list_blocks_command, update_block_command};
use commands::import::{import_files_command, list_documents_command};
use commands::jobs::{
    cancel_job_command, enqueue_mock_job, list_jobs, retry_job_command, run_job_command,
};
use commands::project::{create_project, delete_project, list_projects, open_project};
use commands::reader::{get_source_preview_command, upsert_reader_state_command};
use state::AppState;

fn main() {
    let app_state = AppState::bootstrap().expect("应用状态初始化失败");
    let managed_state = Arc::new(Mutex::new(app_state));

    tauri::Builder::default()
        .manage(managed_state)
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_payload,
            create_project,
            open_project,
            delete_project,
            list_projects,
            import_files_command,
            list_documents_command,
            list_blocks_command,
            update_block_command,
            upsert_reader_state_command,
            get_source_preview_command,
            enqueue_mock_job,
            list_jobs,
            run_job_command,
            retry_job_command,
            cancel_job_command
        ])
        .run(tauri::generate_context!())
        .expect("运行 KnowledgeOS 失败");
}
