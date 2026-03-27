pub mod block_id;
pub mod rebalance;
pub mod structure_chunker;

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::config::AppConfig;
use crate::services::block::{BlockRecord, normalize_block_type};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChunkResponse {
    blocks: Vec<AiChunkBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChunkBlock {
    title: Option<String>,
    #[serde(default)]
    heading_path: Vec<String>,
    block_type: Option<String>,
    content_md: String,
    source_anchor: Option<String>,
}

pub fn chunk_document(
    config: &AppConfig,
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
    let skip_ai_chunking =
        config.model_settings.provider == "mock" || should_skip_ai_chunking(&normalized);
    let chunking_from = if skip_ai_chunking {
        DocumentStatus::Normalized
    } else {
        transition_document_status(
            connection,
            document_id,
            DocumentStatus::Normalized,
            DocumentStatus::AiChunking,
            None,
        )?;
        DocumentStatus::AiChunking
    };
    let draft_blocks = build_draft_blocks(config, &normalized);
    let blocks = persist_blocks(connection, project_root, &current_document, draft_blocks)?;
    transition_document_status(
        connection,
        document_id,
        chunking_from,
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

fn build_draft_blocks(config: &AppConfig, normalized: &NormalizeResult) -> Vec<DraftBlock> {
    if let Ok(ai_blocks) = build_draft_blocks_with_ai(config, normalized) {
        return rebalance_blocks(ai_blocks);
    }

    let structured = chunk_by_structure(&normalized.markdown, &normalized.manifest);
    rebalance_blocks(structured)
}

fn build_draft_blocks_with_ai(
    config: &AppConfig,
    normalized: &NormalizeResult,
) -> Result<Vec<DraftBlock>, String> {
    if config.model_settings.provider == "mock" {
        return Err("mock provider 跳过 AI 分块".to_string());
    }
    if should_skip_ai_chunking(normalized) {
        return Err("文档体量过大，跳过 AI 分块并回退规则分块".to_string());
    }

    let prompt_path = config
        .prompt_templates_dir
        .join("import_semantic_chunk_system.md");
    let system_prompt = fs::read_to_string(prompt_path).map_err(|error| error.to_string())?;
    let adapter = build_model_adapter(&config.model_settings)?;
    let prompt = format!(
        "文档标题：{}\n现有章节：{}\n\n请对下面的 Markdown 做语义分块：\n{}",
        normalized.manifest.title,
        serde_json::to_string_pretty(&normalized.manifest.sections)
            .map_err(|error| error.to_string())?,
        normalized.markdown
    );
    let response = adapter.complete(&ModelRequest {
        task_type: "import.chunk".to_string(),
        provider: config.model_settings.provider.clone(),
        model: config.model_settings.tool_model.clone(),
        system_prompt,
        prompt,
        output_format: "json".to_string(),
        context_blocks: Vec::new(),
        metadata_json: "{}".to_string(),
        temperature: 0.1,
        max_output_tokens: 8000,
    })?;

    let payload: AiChunkResponse =
        serde_json::from_str(&response.output_text).map_err(|error| error.to_string())?;
    if payload.blocks.is_empty() {
        return Err("AI 分块返回了空结果".to_string());
    }

    let total_input_chars = normalized.markdown.chars().count();
    let total_output_chars = payload
        .blocks
        .iter()
        .map(|block| block.content_md.chars().count())
        .sum::<usize>();
    if total_output_chars < (total_input_chars / 2).max(120) {
        return Err("AI 分块结果过短，已回退到规则分块".to_string());
    }

    let draft_blocks = payload
        .blocks
        .into_iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let content_md = block.content_md.trim().to_string();
            if content_md.is_empty() {
                return None;
            }
            let heading_path = if block.heading_path.is_empty() {
                vec![
                    block
                        .title
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| normalized.manifest.title.clone()),
                ]
            } else {
                block.heading_path
            };
            let parent_lookup_key = if heading_path.len() > 1 {
                Some(heading_path[..heading_path.len() - 1].join(" > "))
            } else {
                None
            };
            let fallback_block_type = if heading_path.len() > 1 {
                "section".to_string()
            } else {
                "paragraph".to_string()
            };
            let block_type = block
                .block_type
                .as_deref()
                .map(normalize_block_type)
                .unwrap_or(fallback_block_type);
            Some(DraftBlock {
                title: block.title.filter(|value| !value.trim().is_empty()),
                heading_path,
                depth: 0,
                block_type,
                content_md,
                source_anchor: Some(
                    block
                        .source_anchor
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| format!("semantic-block-{}", index + 1)),
                ),
                parent_lookup_key,
            })
        })
        .collect::<Vec<_>>();

    if draft_blocks.is_empty() {
        return Err("AI 分块过滤后为空".to_string());
    }
    validate_ai_draft_blocks(normalized, &draft_blocks)?;

    Ok(draft_blocks)
}

fn should_skip_ai_chunking(normalized: &NormalizeResult) -> bool {
    let chars = normalized.markdown.chars().count();
    let lines = normalized.markdown.lines().count();
    let section_count = normalized.manifest.sections.len();
    let is_pdf = normalized.manifest.source_type.eq_ignore_ascii_case("pdf");

    if is_pdf {
        return true;
    }
    if chars > 220_000 {
        return true;
    }
    if lines > 6500 {
        return true;
    }
    section_count > 1200
}

fn validate_ai_draft_blocks(
    normalized: &NormalizeResult,
    draft_blocks: &[DraftBlock],
) -> Result<(), String> {
    if draft_blocks.is_empty() {
        return Err("AI 分块结果为空".to_string());
    }

    let normalized_source = normalize_compare_text(&normalized.markdown);
    if normalized_source.len() < 80 {
        return Ok(());
    }

    let mut cursor = 0usize;
    let mut matched_len = 0usize;

    for draft in draft_blocks {
        if draft.heading_path.is_empty() {
            return Err("AI 分块缺少 heading_path".to_string());
        }
        let block_text = normalize_compare_text(&draft.content_md);
        if block_text.is_empty() {
            return Err("AI 分块存在空内容".to_string());
        }

        if let Some((next_cursor, hit_len)) = find_in_order(&normalized_source, cursor, &block_text)
        {
            cursor = next_cursor;
            matched_len += hit_len;
            continue;
        }

        return Err("AI 分块结果与原文顺序不一致，已回退到规则分块".to_string());
    }

    let coverage = matched_len as f64 / normalized_source.len() as f64;
    if coverage < 0.58 {
        return Err("AI 分块覆盖率过低，已回退到规则分块".to_string());
    }

    Ok(())
}

fn find_in_order(source: &str, cursor: usize, content: &str) -> Option<(usize, usize)> {
    if content.is_empty() {
        return Some((cursor, 0));
    }

    let haystack = source.get(cursor..)?;
    if let Some(position) = haystack.find(content) {
        let next_cursor = cursor + position + content.len();
        return Some((next_cursor, content.len()));
    }

    let prefix: String = content.chars().take(32).collect();
    if prefix.len() >= 16
        && let Some(position) = haystack.find(&prefix)
    {
        let next_cursor = cursor + position + prefix.len();
        return Some((next_cursor, prefix.len()));
    }

    None
}

fn normalize_compare_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_alphanumeric()
                || !character.is_ascii_whitespace() && !character.is_ascii_punctuation()
        })
        .flat_map(|character| character.to_lowercase())
        .collect()
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
        let normalized_block_type = normalize_block_type(&draft.block_type);

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
                    normalized_block_type,
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
            block_type: normalize_block_type(&draft.block_type),
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
