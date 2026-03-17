use chrono::Utc;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStateRecord {
    pub project_id: String,
    pub document_id: String,
    pub block_id: String,
    pub source_anchor: Option<String>,
    pub updated_at: String,
}

pub fn list_reader_states(
    connection: &Connection,
) -> Result<Vec<ReaderStateRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT project_id, document_id, block_id, source_anchor, updated_at
         FROM reader_states
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ReaderStateRecord {
            project_id: row.get(0)?,
            document_id: row.get(1)?,
            block_id: row.get(2)?,
            source_anchor: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_reader_state(
    connection: &Connection,
    project_id: &str,
    document_id: &str,
    block_id: &str,
    source_anchor: Option<&str>,
) -> Result<ReaderStateRecord, String> {
    let updated_at = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO reader_states (project_id, document_id, block_id, source_anchor, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_id) DO UPDATE SET
               document_id = excluded.document_id,
               block_id = excluded.block_id,
               source_anchor = excluded.source_anchor,
               updated_at = excluded.updated_at",
            params![project_id, document_id, block_id, source_anchor, updated_at],
        )
        .map_err(|error| error.to_string())?;

    Ok(ReaderStateRecord {
        project_id: project_id.to_string(),
        document_id: document_id.to_string(),
        block_id: block_id.to_string(),
        source_anchor: source_anchor.map(ToOwned::to_owned),
        updated_at,
    })
}
