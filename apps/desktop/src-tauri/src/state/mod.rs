use rusqlite::Connection;

use crate::config::AppConfig;
use crate::db::initialize_database;
use crate::logging::init_logging;
use crate::services::explain::seed_default_explain_templates;
use crate::services::studio::recover_interrupted_studio_artifacts;

pub struct AppState {
    pub config: AppConfig,
    pub db: Connection,
}

impl AppState {
    pub fn bootstrap() -> Result<Self, Box<dyn std::error::Error>> {
        let config = AppConfig::load()?;
        init_logging(&config.log_dir)?;
        let db = initialize_database(&config.database_path, &config.migrations_dir)?;
        seed_default_explain_templates(&db)?;
        let _ = recover_interrupted_studio_artifacts(&db);

        Ok(Self { config, db })
    }
}
