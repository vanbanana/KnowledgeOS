#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
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

use commands::agent::{
    confirm_agent_task_command, generate_agent_preview_command, get_agent_audit_command,
    list_agent_task_logs_command, list_agent_tasks_command, plan_agent_task_command,
    rollback_agent_task_command,
};
use commands::app::get_bootstrap_payload;
use commands::block::{
    delete_block_command, get_block_command, insert_note_block_command, list_blocks_command,
    update_block_command,
};
use commands::card::{list_cards_command, save_card_command, update_card_command};
use commands::explain::{
    explain_block_command, list_block_explanations_command,
    list_document_block_explanations_command, list_explain_templates_command,
    regenerate_block_explanation_command,
};
use commands::graph::{
    confirm_relation_command, get_subgraph_command, graph_rag_query_command,
    remove_relation_command, suggest_relations_command, upsert_relation_command,
};
use commands::import::{
    delete_document_command, get_document_parse_progress_command, get_document_pdf_bytes_command,
    import_files_command, list_documents_command,
};
use commands::jobs::{
    cancel_job_command, enqueue_mock_job, list_jobs, retry_job_command, run_job_command,
};
use commands::project::{
    create_project, delete_project, list_projects, open_project, rename_project,
};
use commands::reader::{
    chat_with_block_command, explain_selection_text_command, get_source_preview_command,
    upsert_reader_state_command,
};
use commands::search::{hybrid_search_project_command, search_project_command};
use commands::studio::{
    cancel_studio_artifact_command, create_studio_artifact_command,
    generate_studio_artifact_command, get_studio_artifact_command, list_studio_artifacts_command,
    query_graph_source_command,
};
use commands::window::{
    close_window_command, minimize_window_command, open_path_command, start_window_drag_command,
    toggle_maximize_window_command,
};
use state::AppState;

fn main() {
    let app_state = AppState::bootstrap().expect("应用状态初始化失败");
    let managed_state = Arc::new(Mutex::new(app_state));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(managed_state)
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_payload,
            create_project,
            open_project,
            rename_project,
            delete_project,
            list_projects,
            import_files_command,
            list_documents_command,
            delete_document_command,
            get_document_parse_progress_command,
            get_document_pdf_bytes_command,
            list_blocks_command,
            get_block_command,
            update_block_command,
            delete_block_command,
            insert_note_block_command,
            explain_block_command,
            regenerate_block_explanation_command,
            list_block_explanations_command,
            list_document_block_explanations_command,
            list_explain_templates_command,
            save_card_command,
            list_cards_command,
            update_card_command,
            search_project_command,
            hybrid_search_project_command,
            get_subgraph_command,
            graph_rag_query_command,
            suggest_relations_command,
            upsert_relation_command,
            confirm_relation_command,
            remove_relation_command,
            upsert_reader_state_command,
            get_source_preview_command,
            chat_with_block_command,
            explain_selection_text_command,
            plan_agent_task_command,
            list_agent_tasks_command,
            generate_agent_preview_command,
            confirm_agent_task_command,
            rollback_agent_task_command,
            list_agent_task_logs_command,
            get_agent_audit_command,
            create_studio_artifact_command,
            generate_studio_artifact_command,
            list_studio_artifacts_command,
            get_studio_artifact_command,
            cancel_studio_artifact_command,
            query_graph_source_command,
            start_window_drag_command,
            minimize_window_command,
            toggle_maximize_window_command,
            close_window_command,
            open_path_command,
            enqueue_mock_job,
            list_jobs,
            run_job_command,
            retry_job_command,
            cancel_job_command
        ])
        .run(tauri::generate_context!())
        .expect("运行 KnowFlow 失败");
}
