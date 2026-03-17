use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use crate::services::block::get_block;
use crate::services::explain::list_block_explanations;
use crate::services::graph::sync_card_node;
use crate::services::search::rebuild_project_search_index;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRecord {
    pub card_id: String,
    pub project_id: String,
    pub source_block_id: Option<String>,
    pub source_explanation_id: Option<String>,
    pub title: String,
    pub content_md: String,
    pub tags_json: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SaveCardInput {
    pub project_id: String,
    pub source_block_id: Option<String>,
    pub source_explanation_id: Option<String>,
    pub title: String,
    pub content_md: String,
    pub tags: Vec<String>,
}

pub fn save_card(connection: &Connection, input: SaveCardInput) -> Result<CardRecord, String> {
    let card_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let tags_json = serde_json::to_string(&input.tags).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO cards (
                card_id, project_id, source_block_id, source_explanation_id, title, content_md, tags_json,
                created_by, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                card_id,
                input.project_id,
                input.source_block_id,
                input.source_explanation_id,
                input.title,
                input.content_md,
                tags_json,
                "user",
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(connection, &card_id)?.ok_or_else(|| "卡片创建失败".to_string())?;
    sync_card_node(connection, &card)?;
    rebuild_project_search_index(connection, &card.project_id)?;
    Ok(card)
}

pub fn save_card_from_block(
    connection: &Connection,
    block_id: &str,
    title: Option<&str>,
    tags: Vec<String>,
) -> Result<CardRecord, String> {
    let block = get_block(connection, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Block 不存在".to_string())?;
    let explanations = list_block_explanations(connection, block_id)?;
    let explanation = explanations.first();
    let default_title = title
        .map(ToOwned::to_owned)
        .or_else(|| block.title.clone())
        .unwrap_or_else(|| format!("Block {}", block.order_index + 1));
    let mut content = String::new();
    if let Some(current) = explanation {
        content.push_str(&format!("# {}\n\n", default_title));
        content.push_str(&format!("## 摘要\n{}\n\n", current.summary));
        let concepts: Vec<serde_json::Value> =
            serde_json::from_str(&current.key_concepts_json).map_err(|error| error.to_string())?;
        if !concepts.is_empty() {
            content.push_str("## 核心概念\n");
            for concept in concepts {
                if let (Some(term), Some(explanation)) = (
                    concept.get("term").and_then(serde_json::Value::as_str),
                    concept
                        .get("explanation")
                        .and_then(serde_json::Value::as_str),
                ) {
                    content.push_str(&format!("- **{}**：{}\n", term, explanation));
                }
            }
            content.push('\n');
        }
        content.push_str("## 来源块\n");
        content.push_str(&block.content_md);
        return save_card(
            connection,
            SaveCardInput {
                project_id: block.project_id,
                source_block_id: Some(block.block_id),
                source_explanation_id: Some(current.explanation_id.clone()),
                title: default_title,
                content_md: content,
                tags,
            },
        );
    }

    save_card(
        connection,
        SaveCardInput {
            project_id: block.project_id,
            source_block_id: Some(block.block_id),
            source_explanation_id: None,
            title: default_title,
            content_md: block.content_md,
            tags,
        },
    )
}

pub fn list_cards(connection: &Connection, project_id: &str) -> Result<Vec<CardRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT card_id, project_id, source_block_id, source_explanation_id, title, content_md, tags_json,
                    created_by, created_at, updated_at
             FROM cards
             WHERE project_id = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], map_card_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_card(connection: &Connection, card_id: &str) -> Result<Option<CardRecord>, String> {
    connection
        .prepare(
            "SELECT card_id, project_id, source_block_id, source_explanation_id, title, content_md, tags_json,
                    created_by, created_at, updated_at
             FROM cards
             WHERE card_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([card_id], map_card_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn update_card(
    connection: &Connection,
    card_id: &str,
    title: &str,
    content_md: &str,
    tags: Vec<String>,
) -> Result<CardRecord, String> {
    let updated_at = Utc::now().to_rfc3339();
    let tags_json = serde_json::to_string(&tags).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE cards
             SET title = ?1, content_md = ?2, tags_json = ?3, updated_at = ?4
             WHERE card_id = ?5",
            params![title, content_md, tags_json, updated_at, card_id],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(connection, card_id)?.ok_or_else(|| "卡片不存在".to_string())?;
    sync_card_node(connection, &card)?;
    rebuild_project_search_index(connection, &card.project_id)?;
    Ok(card)
}

fn map_card_row(row: &rusqlite::Row<'_>) -> Result<CardRecord, rusqlite::Error> {
    Ok(CardRecord {
        card_id: row.get(0)?,
        project_id: row.get(1)?,
        source_block_id: row.get(2)?,
        source_explanation_id: row.get(3)?,
        title: row.get(4)?,
        content_md: row.get(5)?,
        tags_json: row.get(6)?,
        created_by: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
