use rusqlite::Connection;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::db::initialize_database;
use crate::logging::init_logging;
use crate::services::explain::seed_default_explain_templates;

pub struct AppState {
    pub config: AppConfig,
    pub db: Connection,
}

impl AppState {
    pub fn bootstrap() -> Result<Self, Box<dyn std::error::Error>> {
        let config = AppConfig::load()?;
        init_logging(&config.log_dir)?;
        let migrations_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let db = initialize_database(&config.database_path, &migrations_dir)?;
        seed_default_explain_templates(&db)?;

        Ok(Self { config, db })
    }
}
