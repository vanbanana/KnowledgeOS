use chrono::Utc;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRecord {
    pub block_id: String,
    pub project_id: String,
    pub document_id: String,
    pub block_type: String,
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub depth: i64,
    pub order_index: i64,
    pub content_md: String,
    pub token_count: i64,
    pub source_anchor: Option<String>,
    pub parent_block_id: Option<String>,
    pub is_favorite: bool,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list_blocks(
    connection: &Connection,
    document_id: &str,
) -> Result<Vec<BlockRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            block_id, project_id, document_id, block_type, title, heading_path, depth, order_index,
            content_md, token_count, source_anchor, parent_block_id, is_favorite, note, created_at, updated_at
         FROM blocks
         WHERE document_id = ?1
         ORDER BY order_index ASC",
    )?;
    let rows = statement.query_map([document_id], map_block_row)?;
    rows.collect()
}

pub fn get_block(
    connection: &Connection,
    block_id: &str,
) -> Result<Option<BlockRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            block_id, project_id, document_id, block_type, title, heading_path, depth, order_index,
            content_md, token_count, source_anchor, parent_block_id, is_favorite, note, created_at, updated_at
         FROM blocks
         WHERE block_id = ?1",
    )?;
    let mut rows = statement.query([block_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_block_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn update_block_metadata(
    connection: &Connection,
    block_id: &str,
    is_favorite: bool,
    note: Option<&str>,
) -> Result<BlockRecord, String> {
    let affected = connection
        .execute(
            "UPDATE blocks
             SET is_favorite = ?1, note = ?2, updated_at = ?3
             WHERE block_id = ?4",
            params![
                if is_favorite { 1 } else { 0 },
                note,
                Utc::now().to_rfc3339(),
                block_id
            ],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("Block 不存在".to_string());
    }
    get_block(connection, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Block 不存在".to_string())
}

fn map_block_row(row: &rusqlite::Row<'_>) -> Result<BlockRecord, rusqlite::Error> {
    let heading_path_json: String = row.get(5)?;
    let heading_path = serde_json::from_str(&heading_path_json).unwrap_or_default();
    let created_at: String = row.get(14)?;
    let updated_at = row
        .get::<_, Option<String>>(15)?
        .unwrap_or_else(|| created_at.clone());

    Ok(BlockRecord {
        block_id: row.get(0)?,
        project_id: row.get(1)?,
        document_id: row.get(2)?,
        block_type: row.get(3)?,
        title: row.get(4)?,
        heading_path,
        depth: row.get(6)?,
        order_index: row.get(7)?,
        content_md: row.get(8)?,
        token_count: row.get(9)?,
        source_anchor: row.get(10)?,
        parent_block_id: row.get(11)?,
        is_favorite: row.get::<_, i64>(12)? != 0,
        note: row.get(13)?,
        created_at,
        updated_at,
    })
}
