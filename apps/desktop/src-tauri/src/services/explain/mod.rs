use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::ai::model_adapter::{ModelAdapter, ModelRequest};
use crate::services::block::get_block;

pub const EXPLAIN_PROMPT_VERSION: &str = "explain.v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainKeyConcept {
    pub term: String,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRelatedCandidate {
    pub label: String,
    pub relation_hint: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    pub summary: String,
    #[serde(default)]
    pub key_concepts: Vec<ExplainKeyConcept>,
    pub role_in_document: String,
    #[serde(default)]
    pub prerequisites: Vec<String>,
    #[serde(default)]
    pub pitfalls: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub related_candidates: Vec<ExplainRelatedCandidate>,
    #[serde(default)]
    pub role_in_paper: Option<String>,
    #[serde(default)]
    pub key_points: Vec<String>,
    #[serde(default)]
    pub terms: Vec<ExplainKeyConcept>,
    #[serde(default)]
    pub method_or_logic: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub assumptions_or_limits: Option<String>,
    #[serde(default)]
    pub plain_explanation: Option<String>,
    #[serde(default)]
    pub extension: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    pub mode: String,
    pub prompt_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockExplanationRecord {
    pub explanation_id: String,
    pub block_id: String,
    pub mode: String,
    pub summary: String,
    pub key_concepts_json: String,
    pub prerequisites_json: String,
    pub pitfalls_json: String,
    pub role_in_document: String,
    pub related_candidates_json: String,
    pub examples_json: String,
    pub model_name: String,
    pub prompt_version: String,
    pub cache_key: String,
    pub raw_response_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainTemplateRecord {
    pub prompt_version: String,
    pub mode: String,
    pub system_prompt: String,
    pub user_prompt_template: String,
    pub output_schema_json: String,
}

pub fn explain_block(
    connection: &Connection,
    block_id: &str,
    mode: &str,
    model_adapter: &dyn ModelAdapter,
    provider: &str,
    model_name: &str,
) -> Result<BlockExplanationRecord, String> {
    explain_block_with_options(
        connection,
        block_id,
        mode,
        false,
        model_adapter,
        provider,
        model_name,
    )
}

pub fn regenerate_block_explanation(
    connection: &Connection,
    block_id: &str,
    mode: &str,
    model_adapter: &dyn ModelAdapter,
    provider: &str,
    model_name: &str,
) -> Result<BlockExplanationRecord, String> {
    explain_block_with_options(
        connection,
        block_id,
        mode,
        true,
        model_adapter,
        provider,
        model_name,
    )
}

fn explain_block_with_options(
    connection: &Connection,
    block_id: &str,
    mode: &str,
    force_refresh: bool,
    model_adapter: &dyn ModelAdapter,
    provider: &str,
    model_name: &str,
) -> Result<BlockExplanationRecord, String> {
    let block = get_block(connection, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Block 不存在".to_string())?;

    let template =
        get_explain_template(connection, mode)?.ok_or_else(|| "Explain 模板不存在".to_string())?;
    let cache_key = build_cache_key(block_id, mode, model_name, EXPLAIN_PROMPT_VERSION);
    if !force_refresh {
        if let Some(cached) = get_block_explanation_by_cache_key(connection, &cache_key)? {
            return Ok(cached);
        }
    } else {
        connection
            .execute(
                "DELETE FROM block_explanations WHERE cache_key = ?1",
                [cache_key.clone()],
            )
            .map_err(|error| error.to_string())?;
    }

    let prompt = template
        .user_prompt_template
        .replace("{{heading_path}}", &block.heading_path.join(" / "))
        .replace("{{content_md}}", &block.content_md)
        .replace("{{block_id}}", &block.block_id);

    let response = model_adapter.complete(&ModelRequest {
        task_type: "block.explain".to_string(),
        provider: provider.to_string(),
        model: model_name.to_string(),
        system_prompt: template.system_prompt.clone(),
        prompt,
        output_format: "json".to_string(),
        context_blocks: vec![block.content_md.clone()],
        metadata_json: serde_json::json!({
            "blockId": block.block_id,
            "mode": mode,
            "promptVersion": EXPLAIN_PROMPT_VERSION
        })
        .to_string(),
        temperature: 0.2,
        max_output_tokens: 900,
    })?;

    let explain_result = parse_explain_result(mode, &response.output_text)?;

    persist_block_explanation(
        connection,
        &block.block_id,
        &explain_result,
        &response.model,
        &cache_key,
        &response.output_text,
    )
}

pub fn list_block_explanations(
    connection: &Connection,
    block_id: &str,
) -> Result<Vec<BlockExplanationRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT explanation_id, block_id, mode, summary, key_concepts_json, prerequisites_json, pitfalls_json,
                    role_in_document, related_candidates_json, examples_json, model_name, prompt_version, cache_key,
                    raw_response_json, created_at
             FROM block_explanations
             WHERE block_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([block_id], map_block_explanation_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_explain_result(mode: &str, raw: &str) -> Result<ExplainResult, String> {
    let json_text = extract_json_object(raw).unwrap_or(raw).trim();
    let mut value = serde_json::from_str::<Value>(json_text)
        .map_err(|error| format!("Explain JSON 解析失败: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Explain 返回结果不是对象".to_string())?;

    normalize_explain_object(mode, object);

    serde_json::from_value(Value::Object(object.clone()))
        .map_err(|error| format!("Explain JSON 字段不符合要求: {error}"))
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

fn normalize_explain_object(mode: &str, object: &mut Map<String, Value>) {
    let parsed_content = object
        .get("parsed_content")
        .and_then(Value::as_object)
        .cloned();

    if !object.contains_key("summary") {
        let fallback = read_string_field(
            object,
            &[
                "summary",
                "what_is_this_block_about",
                "当前块主题",
                "说明当前块到底在讲什么",
            ],
        )
        .or_else(|| {
            read_nested_string_field(
                parsed_content.as_ref(),
                &[
                    "what_is_this_block_about",
                    "当前块主题",
                    "说明当前块到底在讲什么",
                ],
            )
        })
        .unwrap_or_else(|| "当前块未提供充分信息".to_string());
        object.insert("summary".to_string(), Value::String(fallback));
    }
    if !object.contains_key("roleInDocument") {
        let fallback = read_string_field(object, &["roleInPaper", "role_in_paper"])
            .or_else(|| {
                read_nested_string_field(
                    parsed_content.as_ref(),
                    &[
                        "role_in_paper",
                        "在论文中的作用",
                        "role_in_paper",
                        "role_in_document",
                        "在论文整体中的作用",
                    ],
                )
            })
            .unwrap_or_else(|| "当前块未提供充分信息".to_string());
        object.insert("roleInDocument".to_string(), Value::String(fallback));
    }
    if !object.contains_key("roleInPaper") {
        let fallback = read_string_field(object, &["roleInDocument", "role_in_document"])
            .or_else(|| {
                read_nested_string_field(
                    parsed_content.as_ref(),
                    &["role_in_paper", "在论文中的作用", "在论文整体中的作用"],
                )
            })
            .unwrap_or_else(|| "当前块未提供充分信息".to_string());
        object.insert("roleInPaper".to_string(), Value::String(fallback));
    }
    if !object.contains_key("keyConcepts") {
        if let Some(terms) = object.get("terms").cloned() {
            object.insert("keyConcepts".to_string(), terms);
        } else if let Some(terms) = read_nested_terms(parsed_content.as_ref()) {
            object.insert("keyConcepts".to_string(), terms.clone());
            object.insert("terms".to_string(), terms);
        } else {
            object.insert("keyConcepts".to_string(), Value::Array(Vec::new()));
        }
    }
    ensure_array_field(object, "prerequisites");
    ensure_array_field(object, "pitfalls");
    ensure_array_field(object, "examples");
    ensure_array_field(object, "relatedCandidates");
    if !matches!(object.get("keyPoints"), Some(Value::Array(_))) {
        object.insert(
            "keyPoints".to_string(),
            read_nested_string_array(parsed_content.as_ref(), &["key_points", "最重要要点"])
                .unwrap_or(Value::Array(Vec::new())),
        );
    }
    if !matches!(object.get("terms"), Some(Value::Array(_))) {
        if let Some(terms) = read_nested_terms(parsed_content.as_ref()) {
            object.insert("terms".to_string(), terms);
        } else {
            object.insert("terms".to_string(), Value::Array(Vec::new()));
        }
    }
    ensure_string_field_from_sources(
        object,
        "methodOrLogic",
        "当前块未提供充分信息",
        parsed_content.as_ref(),
        &[
            "methodOrLogic",
            "核心逻辑",
            "核心逻辑或证据",
            "core_logic_if_method",
            "core_logic_if_method_or_experiment",
        ],
    );
    ensure_string_field_from_sources(
        object,
        "evidence",
        "当前块未提供充分信息",
        parsed_content.as_ref(),
        &[
            "evidence",
            "证据或结果",
            "证据或现象",
            "evidence_if_applicable",
            "evidence_if_results_or_observations",
        ],
    );
    ensure_string_field_from_sources(
        object,
        "assumptionsOrLimits",
        "当前块未体现",
        parsed_content.as_ref(),
        &[
            "assumptionsOrLimits",
            "假设、限制或边界条件",
            "假设、限制或边界条件",
            "assumptions_or_limits",
            "assumptions_limitations_boundaries",
        ],
    );
    let default_plain = read_string_field(object, &["summary"])
        .unwrap_or_else(|| "当前块未提供充分信息".to_string());
    ensure_string_field_from_sources(
        object,
        "plainExplanation",
        &default_plain,
        parsed_content.as_ref(),
        &["plainExplanation", "直白解释", "plain_language_explanation"],
    );
    ensure_string_field_from_sources(
        object,
        "extension",
        "可以继续追问相关概念、应用场景和延伸知识。",
        parsed_content.as_ref(),
        &[
            "extension",
            "拓展",
            "延伸理解",
            "further_exploration",
            "related_extension",
        ],
    );
    ensure_string_field(object, "language", "zh");
    ensure_string_field(object, "confidence", "medium");
    ensure_string_field(object, "mode", mode);
    ensure_string_field(object, "promptVersion", EXPLAIN_PROMPT_VERSION);
}

fn read_string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = object.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn ensure_array_field(object: &mut Map<String, Value>, key: &str) {
    if !matches!(object.get(key), Some(Value::Array(_))) {
        object.insert(key.to_string(), Value::Array(Vec::new()));
    }
}

fn ensure_string_field(object: &mut Map<String, Value>, key: &str, default_value: &str) {
    if object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }
    object.insert(key.to_string(), Value::String(default_value.to_string()));
}

fn ensure_string_field_from_sources(
    object: &mut Map<String, Value>,
    key: &str,
    default_value: &str,
    nested: Option<&Map<String, Value>>,
    extra_keys: &[&str],
) {
    if object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }

    let direct = read_string_field(object, extra_keys);
    let nested_value = read_nested_string_field(nested, extra_keys);
    object.insert(
        key.to_string(),
        Value::String(
            direct
                .or(nested_value)
                .unwrap_or_else(|| default_value.to_string()),
        ),
    );
}

fn read_nested_string_field(nested: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let object = nested?;
    read_string_field(object, keys)
}

fn read_nested_string_array(nested: Option<&Map<String, Value>>, keys: &[&str]) -> Option<Value> {
    let object = nested?;
    for key in keys {
        if let Some(Value::Array(items)) = object.get(*key) {
            return Some(Value::Array(items.clone()));
        }
        if let Some(Value::String(text)) = object.get(*key) {
            let items = text
                .lines()
                .map(str::trim)
                .map(|line| {
                    line.trim_start_matches(|ch: char| {
                        ch.is_ascii_digit()
                            || ch == '.'
                            || ch == '-'
                            || ch == '•'
                            || ch.is_whitespace()
                    })
                })
                .filter(|line| !line.is_empty())
                .map(|line| Value::String(line.to_string()))
                .collect::<Vec<_>>();
            if !items.is_empty() {
                return Some(Value::Array(items));
            }
        }
    }
    None
}

fn read_nested_terms(nested: Option<&Map<String, Value>>) -> Option<Value> {
    let object = nested?;
    for key in ["terms", "key_terms", "关键术语解释"] {
        if let Some(Value::Array(items)) = object.get(key) {
            return Some(Value::Array(items.clone()));
        }
        if let Some(Value::Object(map)) = object.get(key) {
            let items = map
                .iter()
                .map(|(term, explanation)| {
                    Value::Object(
                        [
                            ("term".to_string(), Value::String(term.clone())),
                            (
                                "explanation".to_string(),
                                Value::String(explanation.as_str().unwrap_or("").to_string()),
                            ),
                        ]
                        .into_iter()
                        .collect(),
                    )
                })
                .collect::<Vec<_>>();
            if !items.is_empty() {
                return Some(Value::Array(items));
            }
        }
        if let Some(Value::String(text)) = object.get(key) {
            let items = text
                .lines()
                .filter_map(|line| {
                    let trimmed = line.trim().trim_start_matches(|ch: char| {
                        ch.is_ascii_digit()
                            || ch == '.'
                            || ch == '-'
                            || ch == '•'
                            || ch.is_whitespace()
                    });
                    let (term, explanation) = trimmed
                        .split_once('：')
                        .or_else(|| trimmed.split_once(':'))?;
                    Some(Value::Object(
                        [
                            ("term".to_string(), Value::String(term.trim().to_string())),
                            (
                                "explanation".to_string(),
                                Value::String(explanation.trim().to_string()),
                            ),
                        ]
                        .into_iter()
                        .collect(),
                    ))
                })
                .collect::<Vec<_>>();
            if !items.is_empty() {
                return Some(Value::Array(items));
            }
        }
    }
    None
}

pub fn list_document_block_explanations(
    connection: &Connection,
    document_id: &str,
    mode: Option<&str>,
) -> Result<Vec<BlockExplanationRecord>, String> {
    let mut statement = if mode.is_some() {
        connection
            .prepare(
                "SELECT e.explanation_id, e.block_id, e.mode, e.summary, e.key_concepts_json, e.prerequisites_json, e.pitfalls_json,
                        e.role_in_document, e.related_candidates_json, e.examples_json, e.model_name, e.prompt_version, e.cache_key,
                        e.raw_response_json, e.created_at
                 FROM block_explanations e
                 INNER JOIN blocks b ON b.block_id = e.block_id
                 WHERE b.document_id = ?1 AND e.mode = ?2
                 ORDER BY b.order_index ASC, e.created_at DESC",
            )
            .map_err(|error| error.to_string())?
    } else {
        connection
            .prepare(
                "SELECT e.explanation_id, e.block_id, e.mode, e.summary, e.key_concepts_json, e.prerequisites_json, e.pitfalls_json,
                        e.role_in_document, e.related_candidates_json, e.examples_json, e.model_name, e.prompt_version, e.cache_key,
                        e.raw_response_json, e.created_at
                 FROM block_explanations e
                 INNER JOIN blocks b ON b.block_id = e.block_id
                 WHERE b.document_id = ?1
                 ORDER BY b.order_index ASC, e.created_at DESC",
            )
            .map_err(|error| error.to_string())?
    };
    let rows = if let Some(mode_value) = mode {
        statement
            .query_map([document_id, mode_value], map_block_explanation_row)
            .map_err(|error| error.to_string())?
    } else {
        statement
            .query_map([document_id], map_block_explanation_row)
            .map_err(|error| error.to_string())?
    };
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn seed_default_explain_templates(connection: &Connection) -> Result<(), String> {
    let schema_json = serde_json::json!({
        "type": "object",
        "required": [
            "summary",
            "keyConcepts",
            "roleInDocument",
            "prerequisites",
            "pitfalls",
            "examples",
            "relatedCandidates",
            "mode",
            "promptVersion"
        ],
        "properties": {
            "summary": { "type": "string" },
            "keyConcepts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["term", "explanation"],
                    "properties": {
                        "term": { "type": "string" },
                        "explanation": { "type": "string" }
                    }
                }
            },
            "roleInDocument": { "type": "string" },
            "prerequisites": { "type": "array", "items": { "type": "string" } },
            "pitfalls": { "type": "array", "items": { "type": "string" } },
            "examples": { "type": "array", "items": { "type": "string" } },
            "relatedCandidates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["label", "relationHint", "confidence"],
                    "properties": {
                        "label": { "type": "string" },
                        "relationHint": { "type": "string" },
                        "confidence": { "type": "number" }
                    }
                }
            },
            "roleInPaper": { "type": "string" },
            "keyPoints": { "type": "array", "items": { "type": "string" } },
            "terms": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["term", "explanation"],
                    "properties": {
                        "term": { "type": "string" },
                        "explanation": { "type": "string" }
                    }
                }
            },
            "methodOrLogic": { "type": "string" },
            "evidence": { "type": "string" },
            "assumptionsOrLimits": { "type": "string" },
            "plainExplanation": { "type": "string" },
            "extension": { "type": "string" },
            "language": { "type": "string" },
            "confidence": { "type": "string" },
            "mode": { "type": "string" },
            "promptVersion": { "type": "string" }
        }
    })
    .to_string();

    for mode in ["default", "intro", "exam", "research", "paper"] {
        connection
            .execute(
                "INSERT OR REPLACE INTO explain_templates (
                    prompt_version, mode, system_prompt, user_prompt_template, output_schema_json, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    EXPLAIN_PROMPT_VERSION,
                    mode,
                    load_system_prompt_for_mode(mode),
                    build_user_prompt_template(mode),
                    schema_json,
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub fn list_explain_templates(
    connection: &Connection,
) -> Result<Vec<ExplainTemplateRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT prompt_version, mode, system_prompt, user_prompt_template, output_schema_json
             FROM explain_templates
             ORDER BY mode ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ExplainTemplateRecord {
                prompt_version: row.get(0)?,
                mode: row.get(1)?,
                system_prompt: row.get(2)?,
                user_prompt_template: row.get(3)?,
                output_schema_json: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn build_user_prompt_template(mode: &str) -> String {
    if mode == "paper" {
        return "请基于当前文本块输出学习解析模式 JSON。\n模式：paper\nblock_id={{block_id}}\nheading_path={{heading_path}}\ncontent_md:\n{{content_md}}\n只输出 JSON。".to_string();
    }
    format!(
        "请基于以下块内容生成结构化 Explain JSON。\n模式：{mode}\nblock_id={{block_id}}\nheading_path={{heading_path}}\ncontent_md:\n{{content_md}}\n只输出 JSON。"
    )
}

fn load_system_prompt_for_mode(mode: &str) -> String {
    if mode != "paper" {
        return "你是 KnowledgeOS 的块级解释助手。只能输出 JSON，不允许输出额外文本。".to_string();
    }

    let prompt_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("prompt-templates")
        .join("paper_block_explain_system.md");
    fs::read_to_string(prompt_path).unwrap_or_else(|_| {
        "你是 KnowledgeOS 的论文块解析助手。无论原文是中文还是英文，都必须输出中文 JSON，术语首次出现时保留英文原词并补充中文解释。只能基于当前块内容回答，不允许输出额外文本。".to_string()
    })
}

fn get_explain_template(
    connection: &Connection,
    mode: &str,
) -> Result<Option<ExplainTemplateRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT prompt_version, mode, system_prompt, user_prompt_template, output_schema_json
             FROM explain_templates
             WHERE prompt_version = ?1 AND mode = ?2
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([EXPLAIN_PROMPT_VERSION, mode])
        .map_err(|error| error.to_string())?;
    if let Some(row) = rows.next().map_err(|error| error.to_string())? {
        Ok(Some(ExplainTemplateRecord {
            prompt_version: row.get(0).map_err(|error| error.to_string())?,
            mode: row.get(1).map_err(|error| error.to_string())?,
            system_prompt: row.get(2).map_err(|error| error.to_string())?,
            user_prompt_template: row.get(3).map_err(|error| error.to_string())?,
            output_schema_json: row.get(4).map_err(|error| error.to_string())?,
        }))
    } else {
        Ok(None)
    }
}

fn get_block_explanation_by_cache_key(
    connection: &Connection,
    cache_key: &str,
) -> Result<Option<BlockExplanationRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT explanation_id, block_id, mode, summary, key_concepts_json, prerequisites_json, pitfalls_json,
                    role_in_document, related_candidates_json, examples_json, model_name, prompt_version, cache_key,
                    raw_response_json, created_at
             FROM block_explanations
             WHERE cache_key = ?1
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([cache_key])
        .map_err(|error| error.to_string())?;
    if let Some(row) = rows.next().map_err(|error| error.to_string())? {
        map_block_explanation_row(row)
            .map(Some)
            .map_err(|error| error.to_string())
    } else {
        Ok(None)
    }
}

fn persist_block_explanation(
    connection: &Connection,
    block_id: &str,
    explain_result: &ExplainResult,
    model_name: &str,
    cache_key: &str,
    raw_response_json: &str,
) -> Result<BlockExplanationRecord, String> {
    let explanation_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let key_concepts_json =
        serde_json::to_string(&explain_result.key_concepts).map_err(|error| error.to_string())?;
    let prerequisites_json =
        serde_json::to_string(&explain_result.prerequisites).map_err(|error| error.to_string())?;
    let pitfalls_json =
        serde_json::to_string(&explain_result.pitfalls).map_err(|error| error.to_string())?;
    let examples_json =
        serde_json::to_string(&explain_result.examples).map_err(|error| error.to_string())?;
    let related_candidates_json = serde_json::to_string(&explain_result.related_candidates)
        .map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO block_explanations (
                explanation_id, block_id, mode, summary, key_concepts_json, prerequisites_json, pitfalls_json,
                role_in_document, related_candidates_json, examples_json, model_name, prompt_version, cache_key,
                raw_response_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                explanation_id,
                block_id,
                explain_result.mode,
                explain_result.summary,
                key_concepts_json,
                prerequisites_json,
                pitfalls_json,
                explain_result.role_in_document,
                related_candidates_json,
                examples_json,
                model_name,
                explain_result.prompt_version,
                cache_key,
                raw_response_json,
                created_at
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(BlockExplanationRecord {
        explanation_id,
        block_id: block_id.to_string(),
        mode: explain_result.mode.clone(),
        summary: explain_result.summary.clone(),
        key_concepts_json,
        prerequisites_json,
        pitfalls_json,
        role_in_document: explain_result.role_in_document.clone(),
        related_candidates_json,
        examples_json,
        model_name: model_name.to_string(),
        prompt_version: explain_result.prompt_version.clone(),
        cache_key: cache_key.to_string(),
        raw_response_json: raw_response_json.to_string(),
        created_at,
    })
}

fn build_cache_key(block_id: &str, mode: &str, model_name: &str, prompt_version: &str) -> String {
    format!("{block_id}:{mode}:{model_name}:{prompt_version}")
}

fn map_block_explanation_row(
    row: &rusqlite::Row<'_>,
) -> Result<BlockExplanationRecord, rusqlite::Error> {
    Ok(BlockExplanationRecord {
        explanation_id: row.get(0)?,
        block_id: row.get(1)?,
        mode: row.get(2)?,
        summary: row.get(3)?,
        key_concepts_json: row.get(4)?,
        prerequisites_json: row.get(5)?,
        pitfalls_json: row.get(6)?,
        role_in_document: row.get(7)?,
        related_candidates_json: row.get(8)?,
        examples_json: row.get(9)?,
        model_name: row.get(10)?,
        prompt_version: row.get(11)?,
        cache_key: row.get(12)?,
        raw_response_json: row.get(13)?,
        created_at: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use uuid::Uuid;

    use super::{
        EXPLAIN_PROMPT_VERSION, ExplainKeyConcept, ExplainRelatedCandidate, ExplainResult,
        explain_block, list_explain_templates, regenerate_block_explanation,
        seed_default_explain_templates,
    };
    use crate::ai::model_adapter::{ModelAdapter, ModelRequest, ModelResponse};
    use crate::db::initialize_database;
    use crate::services::block::BlockRecord;
    use crate::services::chunk::DraftBlock;
    use crate::services::chunk::persist_blocks;
    use crate::services::import::DocumentRecord;
    use crate::services::project::{create_project_record, initialize_project_directories};

    #[test]
    fn 应可生成_explain_模板与_mock_explain() {
        let temp_root =
            std::env::temp_dir().join(format!("knowledgeos-explain-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("创建临时目录失败");
        let data_dir = temp_root.join(".knowledgeos").join("data");
        let projects_dir = data_dir.join("projects");
        fs::create_dir_all(&projects_dir).expect("创建 projects 目录失败");
        let database_path = data_dir.join("app.db");
        let migrations_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection =
            initialize_database(&database_path, &migrations_dir).expect("初始化数据库失败");

        seed_default_explain_templates(&connection).expect("写入 explain 模板失败");
        let templates = list_explain_templates(&connection).expect("查询 explain 模板失败");
        assert!(
            templates
                .iter()
                .any(|item| item.prompt_version == EXPLAIN_PROMPT_VERSION)
        );

        let project = create_project_record(&connection, &projects_dir, "Explain 测试项目", None)
            .expect("创建项目失败");
        initialize_project_directories(&project.root_path).expect("初始化项目目录失败");
        connection.execute(
            "INSERT INTO documents (
                document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
                parse_status, imported_at, updated_at, last_error_message
            ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?6, ?7, ?8, NULL)",
            rusqlite::params![
                "doc-1",
                project.project_id,
                "E:\\NOTE\\fixtures\\documents\\sample-note.md",
                "md",
                "Explain 文档",
                "chunked",
                chrono::Utc::now().to_rfc3339(),
                chrono::Utc::now().to_rfc3339()
            ],
        ).expect("插入文档失败");

        let document = DocumentRecord {
            document_id: "doc-1".to_string(),
            project_id: project.project_id.clone(),
            source_path: "E:\\NOTE\\fixtures\\documents\\sample-note.md".to_string(),
            source_type: "md".to_string(),
            source_hash: None,
            normalized_md_path: None,
            manifest_path: None,
            title: Some("Explain 文档".to_string()),
            parse_status: "chunked".to_string(),
            imported_at: chrono::Utc::now().to_rfc3339(),
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            last_error_message: None,
        };
        let blocks = persist_blocks(
            &connection,
            PathBuf::from(&project.root_path).as_path(),
            &document,
            vec![DraftBlock {
                title: Some("测试块".to_string()),
                heading_path: vec!["测试块".to_string()],
                depth: 0,
                block_type: "section".to_string(),
                content_md: "这是一个用于 explain 的测试块。".to_string(),
                source_anchor: Some("section-1".to_string()),
                parent_lookup_key: None,
            }],
        )
        .expect("写入 blocks 失败");

        let adapter = TestModelAdapter;
        let explanation = explain_block(
            &connection,
            &blocks[0].block_id,
            "default",
            &adapter,
            "mock",
            "mock-explain-001",
        )
        .expect("生成 explain 失败");
        assert_eq!(explanation.mode, "default");
        assert!(!explanation.summary.is_empty());
        let regenerated = regenerate_block_explanation(
            &connection,
            &blocks[0].block_id,
            "default",
            &adapter,
            "mock",
            "mock-explain-001",
        )
        .expect("重算 explain 失败");
        assert_ne!(regenerated.explanation_id, explanation.explanation_id);
    }

    struct TestModelAdapter;

    impl ModelAdapter for TestModelAdapter {
        fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, String> {
            let payload = ExplainResult {
                summary: format!("测试 explain：{}", request.task_type),
                key_concepts: vec![ExplainKeyConcept {
                    term: "测试概念".to_string(),
                    explanation: "由测试模型返回".to_string(),
                }],
                role_in_document: "测试角色".to_string(),
                prerequisites: vec!["测试前置".to_string()],
                pitfalls: vec!["测试陷阱".to_string()],
                examples: vec!["测试示例".to_string()],
                related_candidates: vec![ExplainRelatedCandidate {
                    label: "测试节点".to_string(),
                    relation_hint: "related".to_string(),
                    confidence: 0.7,
                }],
                role_in_paper: Some("方法说明".to_string()),
                key_points: vec!["测试要点".to_string()],
                terms: vec![ExplainKeyConcept {
                    term: "Transformer".to_string(),
                    explanation: "测试术语解释".to_string(),
                }],
                method_or_logic: Some("测试逻辑".to_string()),
                evidence: Some("测试证据".to_string()),
                assumptions_or_limits: Some("测试限制".to_string()),
                plain_explanation: Some("测试白话解释".to_string()),
                language: Some("zh".to_string()),
                confidence: Some("high".to_string()),
                mode: "default".to_string(),
                prompt_version: EXPLAIN_PROMPT_VERSION.to_string(),
            };
            Ok(ModelResponse {
                provider: "mock".to_string(),
                model: "mock-explain-001".to_string(),
                output_text: serde_json::to_string(&payload).map_err(|error| error.to_string())?,
                input_tokens: 10,
                output_tokens: 20,
                total_tokens: 30,
                duration_ms: 1,
                cache_hit: false,
            })
        }
    }

    #[allow(dead_code)]
    fn _block_record(_: &BlockRecord) {}
}
