use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

pub fn initialize_database(
    database_path: &Path,
    migrations_dir: &Path,
) -> Result<Connection, rusqlite::Error> {
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent).map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
    }

    let connection = Connection::open(database_path)?;
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    run_migrations(&connection, migrations_dir)?;
    Ok(connection)
}

fn run_migrations(connection: &Connection, migrations_dir: &Path) -> Result<(), rusqlite::Error> {
    connection.execute(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )",
        [],
    )?;

    let mut entries = fs::read_dir(migrations_dir)
        .map_err(|_| rusqlite::Error::ExecuteReturnedResults)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        let is_sql = path.extension().and_then(|ext| ext.to_str()) == Some("sql");
        if !is_sql {
            continue;
        }

        let version = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(rusqlite::Error::ExecuteReturnedResults)?;
        let applied: Option<String> = connection
            .query_row(
                "SELECT version FROM _migrations WHERE version = ?1",
                [version],
                |row| row.get(0),
            )
            .optional()?;

        if applied.is_some() {
            continue;
        }

        let sql = fs::read_to_string(&path).map_err(|_| rusqlite::Error::ExecuteReturnedResults)?;
        connection.execute_batch(&sql)?;
        connection.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (?1, datetime('now'))",
            [version],
        )?;
    }

    Ok(())
}
