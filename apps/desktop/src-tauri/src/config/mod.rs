use std::path::PathBuf;

use serde::Serialize;

use crate::fs::ensure_directory;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub app_name: String,
    pub workspace_root: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub database_path: PathBuf,
    pub parser_worker_path: PathBuf,
}

impl AppConfig {
    pub fn load() -> Result<Self, std::io::Error> {
        let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .canonicalize()?;
        let base_dir = workspace_root.join(".knowledgeos");
        let data_dir = base_dir.join("data");
        let log_dir = base_dir.join("logs");
        let projects_dir = data_dir.join("projects");
        let database_path = data_dir.join("app.db");
        let parser_worker_path = workspace_root
            .join("workers")
            .join("parser")
            .join("main.py");

        ensure_directory(&base_dir)?;
        ensure_directory(&data_dir)?;
        ensure_directory(&log_dir)?;
        ensure_directory(&projects_dir)?;

        Ok(Self {
            app_name: "KnowledgeOS".to_string(),
            workspace_root,
            data_dir,
            log_dir,
            projects_dir,
            database_path,
            parser_worker_path,
        })
    }
}
