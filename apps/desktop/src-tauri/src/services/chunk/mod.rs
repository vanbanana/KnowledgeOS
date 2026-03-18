pub mod block_id;
pub mod rebalance;
pub mod structure_chunker;

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::services::block::BlockRecord;
use crate::services::import::{
    DocumentRecord, DocumentStatus, get_document, transition_document_status,
};
use crate::services::normalize::{NormalizeResult, read_normalized_result};

use self::block_id::build_block_id;
use self::rebalance::{estimate_tokens, rebalance_blocks};
use self::structure_chunker::chunk_by_structure;

#[derive(Debug, Clone)]
pub struct DraftBlock {
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub depth: i64,
    pub block_type: String,
    pub content_md: String,
    pub source_anchor: Option<String>,
    pub parent_lookup_key: Option<String>,
}

pub fn chunk_document(
    connection: &Connection,
    project_root: &Path,
    document_id: &str,
) -> Result<Vec<BlockRecord>, String> {
    let document = get_document(connection, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;

    if document.parse_status == DocumentStatus::Failed.to_string() {
        transition_document_status(
            connection,
            document_id,
            DocumentStatus::Failed,
            DocumentStatus::Normalized,
            None,
        )?;
    }

    let current_document = get_document(connection, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;
    if current_document.parse_status != DocumentStatus::Normalized.to_string() {
        return Err("只有 normalized 文档可以切块".to_string());
    }

    let normalized = read_normalized_result(&current_document)?;
    let structured = chunk_by_structure(&normalized.markdown, &normalized.manifest);
    let draft_blocks = rebalance_blocks(structured);
    let blocks = persist_blocks(connection, project_root, &current_document, draft_blocks)?;
    transition_document_status(
        connection,
        document_id,
        DocumentStatus::Normalized,
        DocumentStatus::Chunked,
        None,
    )?;
    Ok(blocks)
}

pub fn rebuild_missing_blocks(
    connection: &Connection,
    project_root: &Path,
    document_id: &str,
) -> Result<Vec<BlockRecord>, String> {
    let document = get_document(connection, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;

    let normalized_path = document
        .normalized_md_path
        .as_ref()
        .ok_or_else(|| "缺少 normalized markdown".to_string())?;
    if !normalize_filesystem_path(normalized_path).exists() {
        return Err("normalized markdown 文件不存在".to_string());
    }

    let normalized = read_normalized_result(&document)?;
    let structured = chunk_by_structure(&normalized.markdown, &normalized.manifest);
    let draft_blocks = rebalance_blocks(structured);
    let blocks = persist_blocks(connection, project_root, &document, draft_blocks)?;

    let current_status = DocumentStatus::try_from(document.parse_status.as_str())?;
    if current_status == DocumentStatus::Normalized {
        transition_document_status(
            connection,
            document_id,
            DocumentStatus::Normalized,
            DocumentStatus::Chunked,
            None,
        )?;
    }

    Ok(blocks)
}

fn normalize_filesystem_path(path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(path.trim_start_matches(r"\\?\"))
}

pub fn persist_blocks(
    connection: &Connection,
    project_root: &Path,
    document: &DocumentRecord,
    draft_blocks: Vec<DraftBlock>,
) -> Result<Vec<BlockRecord>, String> {
    let now = Utc::now().to_rfc3339();
    let mut parent_id_map: HashMap<String, String> = HashMap::new();
    let mut block_records = Vec::new();

    connection
        .execute(
            "DELETE FROM blocks WHERE document_id = ?1",
            [document.document_id.as_str()],
        )
        .map_err(|error| error.to_string())?;

    for (order_index, draft) in draft_blocks.into_iter().enumerate() {
        let content_md = draft.content_md.trim().to_string();
        if content_md.is_empty() {
            continue;
        }

        let parent_block_id = draft
            .parent_lookup_key
            .as_ref()
            .and_then(|key| parent_id_map.get(key))
            .cloned();
        let block_id = build_block_id(
            &document.document_id,
            &draft.heading_path,
            draft.source_anchor.as_deref(),
            &content_md,
        );
        let heading_path_json =
            serde_json::to_string(&draft.heading_path).map_err(|error| error.to_string())?;
        let token_count = estimate_tokens(&content_md) as i64;

        connection
            .execute(
                "INSERT INTO blocks (
                    block_id, project_id, document_id, block_type, heading_path, order_index, content_md,
                    token_count, source_anchor, parent_block_id, created_at, title, depth, updated_at, is_favorite, note
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    block_id,
                    document.project_id,
                    document.document_id,
                    draft.block_type,
                    heading_path_json,
                    order_index as i64,
                    content_md,
                    token_count,
                    draft.source_anchor,
                    parent_block_id,
                    now,
                    draft.title,
                    draft.depth,
                    now,
                    0,
                    Option::<String>::None
                ],
            )
            .map_err(|error| error.to_string())?;

        let block = BlockRecord {
            block_id: block_id.clone(),
            project_id: document.project_id.clone(),
            document_id: document.document_id.clone(),
            block_type: draft.block_type,
            title: draft.title.clone(),
            heading_path: draft.heading_path.clone(),
            depth: draft.depth,
            order_index: order_index as i64,
            content_md,
            token_count,
            source_anchor: draft.source_anchor.clone(),
            parent_block_id,
            is_favorite: false,
            note: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        if draft.title.is_some() {
            parent_id_map.insert(draft.heading_path.join(" > "), block_id.clone());
        }
        block_records.push(block);
    }

    write_blocks_jsonl(project_root, &document.document_id, &block_records)?;
    Ok(block_records)
}

pub fn write_blocks_jsonl(
    project_root: &Path,
    document_id: &str,
    blocks: &[BlockRecord],
) -> Result<(), String> {
    let blocks_dir = project_root.join("blocks");
    fs::create_dir_all(&blocks_dir).map_err(|error| error.to_string())?;
    let jsonl_path = blocks_dir.join(format!("{document_id}.jsonl"));
    let mut lines = Vec::new();
    for block in blocks {
        lines.push(serde_json::to_string(block).map_err(|error| error.to_string())?);
    }
    fs::write(jsonl_path, lines.join("\n")).map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreview {
    pub anchor: String,
    pub title: Option<String>,
    pub excerpt_md: String,
}

pub fn get_source_preview(
    connection: &Connection,
    document_id: &str,
    anchor: &str,
) -> Result<SourcePreview, String> {
    let document = get_document(connection, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;
    let normalized = read_normalized_result(&document)?;
    let excerpt = extract_anchor_excerpt(&normalized, anchor);
    Ok(SourcePreview {
        anchor: anchor.to_string(),
        title: normalized
            .manifest
            .sections
            .iter()
            .find(|section| section.anchor == anchor)
            .and_then(|section| section.heading.clone()),
        excerpt_md: excerpt,
    })
}

fn extract_anchor_excerpt(normalized: &NormalizeResult, anchor: &str) -> String {
    let lines: Vec<&str> = normalized.markdown.lines().collect();
    let headings: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim();
            let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
            if hashes == 0 || trimmed.chars().nth(hashes) != Some(' ') {
                return None;
            }
            Some((index, trimmed[hashes + 1..].trim().to_string()))
        })
        .collect();

    let target_title = normalized
        .manifest
        .sections
        .iter()
        .find(|section| section.anchor == anchor)
        .and_then(|section| section.heading.clone());

    if let Some(title) = target_title {
        for (index, (_, heading)) in headings.iter().enumerate() {
            if *heading == title {
                let start = headings[index].0;
                let end = headings
                    .get(index + 1)
                    .map(|value| value.0)
                    .unwrap_or(lines.len());
                return lines[start..end].join("\n").trim().to_string();
            }
        }
    }

    lines.into_iter().take(24).collect::<Vec<_>>().join("\n")
}
