use std::path::PathBuf;

use serde::Serialize;

use crate::fs::ensure_directory;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub app_name: String,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub database_path: PathBuf,
}

impl AppConfig {
    pub fn load() -> Result<Self, std::io::Error> {
        let base_dir = std::env::current_dir()?.join(".knowledgeos");
        let data_dir = base_dir.join("data");
        let log_dir = base_dir.join("logs");
        let projects_dir = data_dir.join("projects");
        let database_path = data_dir.join("app.db");

        ensure_directory(&base_dir)?;
        ensure_directory(&data_dir)?;
        ensure_directory(&log_dir)?;
        ensure_directory(&projects_dir)?;

        Ok(Self {
            app_name: "KnowledgeOS".to_string(),
            data_dir,
            log_dir,
            projects_dir,
            database_path,
        })
    }
}
