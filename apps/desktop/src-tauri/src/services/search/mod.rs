use rusqlite::{Connection, params};
use serde::Serialize;

use crate::services::vector::{MockVectorIndex, VectorIndex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultRecord {
    pub entity_type: String,
    pub entity_id: String,
    pub project_id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub jump_target: String,
    pub score: f64,
}

pub fn search_project(
    connection: &Connection,
    project_id: &str,
    query: &str,
) -> Result<Vec<SearchResultRecord>, String> {
    rebuild_project_search_index(connection, project_id)?;
    let match_query = build_match_query(query);
    if match_query.is_empty() {
        return Ok(Vec::new());
    }

    let mut statement = connection
        .prepare(
            "SELECT entity_type, entity_id, project_id, title,
                    snippet(search_fts, 4, '[', ']', '…', 18) AS snippet
             FROM search_fts
             WHERE project_id = ?1 AND search_fts MATCH ?2
             ORDER BY rank
             LIMIT 20",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id, match_query], |row| {
            let entity_type: String = row.get(0)?;
            let entity_id: String = row.get(1)?;
            let project_id: String = row.get(2)?;
            let title: String = row.get(3)?;
            let snippet: String = row.get(4)?;
            Ok(SearchResultRecord {
                jump_target: entity_id.clone(),
                source: "fts".to_string(),
                score: 1.0,
                entity_type,
                entity_id,
                project_id,
                title,
                snippet,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn hybrid_search_project(
    connection: &Connection,
    project_id: &str,
    query: &str,
) -> Result<Vec<SearchResultRecord>, String> {
    let mut merged = search_project(connection, project_id, query)?;
    let vector_index = MockVectorIndex;
    let vector_hits = vector_index.query(connection, project_id, query, 10)?;

    for hit in vector_hits {
        if let Some(existing) = merged
            .iter_mut()
            .find(|item| item.entity_type == hit.entity_type && item.entity_id == hit.entity_id)
        {
            existing.score += hit.score;
            if existing.snippet.is_empty() {
                existing.snippet = hit.snippet.clone();
            }
            continue;
        }

        merged.push(SearchResultRecord {
            entity_type: hit.entity_type,
            entity_id: hit.entity_id,
            project_id: hit.project_id,
            title: hit.title,
            snippet: hit.snippet,
            source: "semantic".to_string(),
            jump_target: hit.jump_target,
            score: hit.score,
        });
    }

    merged.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(20);
    Ok(merged)
}

pub fn rebuild_project_search_index(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM search_fts WHERE project_id = ?1", [project_id])
        .map_err(|error| error.to_string())?;

    let mut document_statement = connection
        .prepare(
            "SELECT document_id, COALESCE(title, source_path), source_path
             FROM documents
             WHERE project_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let document_rows = document_statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in document_rows {
        let (document_id, title, source_path) = row.map_err(|error| error.to_string())?;
        insert_index_row(
            connection,
            "document",
            &document_id,
            project_id,
            &title,
            &source_path,
        )?;
    }

    let mut block_statement = connection
        .prepare(
            "SELECT block_id, COALESCE(title, block_type), content_md
             FROM blocks
             WHERE project_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let block_rows = block_statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in block_rows {
        let (block_id, title, content_md) = row.map_err(|error| error.to_string())?;
        insert_index_row(
            connection,
            "block",
            &block_id,
            project_id,
            &title,
            &content_md,
        )?;
    }

    let mut card_statement = connection
        .prepare(
            "SELECT card_id, title, content_md
             FROM cards
             WHERE project_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let card_rows = card_statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in card_rows {
        let (card_id, title, content_md) = row.map_err(|error| error.to_string())?;
        insert_index_row(
            connection,
            "card",
            &card_id,
            project_id,
            &title,
            &content_md,
        )?;
    }

    Ok(())
}

fn insert_index_row(
    connection: &Connection,
    entity_type: &str,
    entity_id: &str,
    project_id: &str,
    title: &str,
    body: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO search_fts (entity_type, entity_id, project_id, title, body)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![entity_type, entity_id, project_id, title, body],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn build_match_query(query: &str) -> String {
    query
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.trim().is_empty())
        .map(|token| format!("\"{}\"*", token.trim()))
        .collect::<Vec<_>>()
        .join(" ")
}
