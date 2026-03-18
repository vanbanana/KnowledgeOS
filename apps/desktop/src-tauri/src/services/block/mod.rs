use chrono::Utc;
use rusqlite::{Connection, params};
use serde::Serialize;
use uuid::Uuid;

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
    is_favorite: Option<bool>,
    note: Option<&str>,
    title: Option<&str>,
    content_md: Option<&str>,
) -> Result<BlockRecord, String> {
    let existing = get_block(connection, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Block 不存在".to_string())?;
    let next_is_favorite = is_favorite.unwrap_or(existing.is_favorite);
    let next_note = note.or(existing.note.as_deref());
    let next_title = match title {
        Some(value) => Some(value),
        None => existing.title.as_deref(),
    };
    let next_content_md = content_md.unwrap_or(&existing.content_md);
    let next_token_count = estimate_token_count(next_content_md);
    let affected = connection
        .execute(
            "UPDATE blocks
             SET is_favorite = ?1, note = ?2, title = ?3, content_md = ?4, token_count = ?5, updated_at = ?6
             WHERE block_id = ?7",
            params![
                if next_is_favorite { 1 } else { 0 },
                next_note,
                next_title,
                next_content_md,
                next_token_count,
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

pub fn delete_block(connection: &Connection, block_id: &str) -> Result<(), String> {
    let block = get_block(connection, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Block 不存在".to_string())?;
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "DELETE FROM block_explanations WHERE block_id = ?1",
        [block_id],
    )
    .map_err(|error| error.to_string())?;
    connection.execute(
        "DELETE FROM cards WHERE source_block_id = ?1",
        [block_id],
    )
    .map_err(|error| error.to_string())?;
    connection.execute(
        "DELETE FROM search_fts WHERE entity_type = 'block' AND entity_id = ?1",
        [block_id],
    )
    .map_err(|error| error.to_string())?;
    connection.execute(
        "DELETE FROM graph_relations
         WHERE source_ref = ?1
            OR from_node_id IN (SELECT node_id FROM graph_nodes WHERE source_ref = ?1)
            OR to_node_id IN (SELECT node_id FROM graph_nodes WHERE source_ref = ?1)",
        [block_id],
    )
    .map_err(|error| error.to_string())?;
    connection.execute(
        "DELETE FROM graph_nodes WHERE source_ref = ?1",
        [block_id],
    )
    .map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM blocks WHERE block_id = ?1", [block_id])
        .map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE blocks
         SET order_index = order_index - 1, updated_at = ?1
         WHERE document_id = ?2 AND order_index > ?3",
        params![now, block.document_id, block.order_index],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn insert_note_block(
    connection: &Connection,
    document_id: &str,
    before_block_id: Option<&str>,
    title: Option<&str>,
    content_md: &str,
) -> Result<BlockRecord, String> {
    let (project_id, target_order_index) =
        resolve_insert_position(connection, document_id, before_block_id)?;
    let now = Utc::now().to_rfc3339();
    let block_id = format!("note-{}", Uuid::new_v4());
    let heading_path_json = serde_json::to_string(&Vec::<String>::new()).unwrap_or("[]".to_string());
    let token_count = estimate_token_count(content_md);

    connection
        .execute(
            "UPDATE blocks
             SET order_index = order_index + 1, updated_at = ?1
             WHERE document_id = ?2 AND order_index >= ?3",
            params![now, document_id, target_order_index],
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO blocks (
                block_id, project_id, document_id, block_type, title, heading_path, depth,
                order_index, content_md, token_count, source_anchor, parent_block_id,
                is_favorite, note, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                block_id,
                project_id,
                document_id,
                "note",
                title,
                heading_path_json,
                0i64,
                target_order_index,
                content_md,
                token_count,
                Option::<String>::None,
                Option::<String>::None,
                0i64,
                Option::<String>::None,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;

    get_block(connection, &block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "插入笔记块失败".to_string())
}

fn resolve_insert_position(
    connection: &Connection,
    document_id: &str,
    before_block_id: Option<&str>,
) -> Result<(String, i64), String> {
    let project_id: String = connection
        .query_row(
            "SELECT project_id FROM documents WHERE document_id = ?1",
            [document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let target_order_index = if let Some(block_id) = before_block_id {
        connection
            .query_row(
                "SELECT order_index FROM blocks WHERE document_id = ?1 AND block_id = ?2",
                params![document_id, block_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?
    } else {
        let max_order_index: Option<i64> = connection
            .query_row(
                "SELECT MAX(order_index) FROM blocks WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        max_order_index.unwrap_or(-1) + 1
    };

    Ok((project_id, target_order_index))
}

fn estimate_token_count(content_md: &str) -> i64 {
    ((content_md.chars().count() as f64) / 4.0).ceil() as i64
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
