use rusqlite::Connection;

use crate::config::AppConfig;
use crate::db::initialize_database;
use crate::logging::init_logging;

pub struct AppState {
    pub config: AppConfig,
    pub db: Connection,
}

impl AppState {
    pub fn bootstrap() -> Result<Self, Box<dyn std::error::Error>> {
        let config = AppConfig::load()?;
        init_logging(&config.log_dir)?;
        let migrations_dir = std::env::current_dir()?.join("apps/desktop/src-tauri/migrations");
        let db = initialize_database(&config.database_path, &migrations_dir)?;

        Ok(Self { config, db })
    }
}
