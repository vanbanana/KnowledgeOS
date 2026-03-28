use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::ai::model_adapter::{ModelRequest, stream_text_completion};
use crate::services::block::get_block;
use crate::services::chunk::{SourcePreview, get_source_preview};
use crate::services::reader_state::{ReaderStateRecord, upsert_reader_state};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertReaderStatePayload {
    pub project_id: String,
    pub document_id: String,
    pub block_id: String,
    pub source_anchor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreviewPayload {
    pub document_id: String,
    pub anchor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWithBlockPayload {
    pub block_id: Option<String>,
    pub question: String,
    pub request_id: String,
    pub history: Vec<ChatHistoryItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSelectionTextPayload {
    pub selected_text: String,
    pub document_id: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryItem {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStateCommandResponse {
    pub reader_state: ReaderStateRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreviewCommandResponse {
    pub preview: SourcePreview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWithBlockCommandResponse {
    pub answer: String,
    pub model: String,
    pub provider: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionExplainTerm {
    pub term: String,
    pub explanation: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSelectionTextCommandResponse {
    pub summary: String,
    pub plain_explanation: String,
    pub key_points: Vec<String>,
    pub prerequisites: Vec<String>,
    pub pitfalls: Vec<String>,
    pub examples: Vec<String>,
    pub terms: Vec<SelectionExplainTerm>,
    pub extension: Vec<String>,
    pub confidence: String,
    pub raw_json: String,
    pub model: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionExplainStreamEventPayload {
    request_id: String,
    chunk: String,
    done: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamEventPayload {
    request_id: String,
    chunk: String,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn upsert_reader_state_command(
    payload: UpsertReaderStatePayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ReaderStateCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let reader_state = upsert_reader_state(
        &app_state.db,
        &payload.project_id,
        &payload.document_id,
        &payload.block_id,
        payload.source_anchor.as_deref(),
    )?;
    Ok(ReaderStateCommandResponse { reader_state })
}

#[tauri::command]
pub fn get_source_preview_command(
    payload: SourcePreviewPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<SourcePreviewCommandResponse, String> {
    let app_state = state.lock().map_err(|error| error.to_string())?;
    let preview = get_source_preview(&app_state.db, &payload.document_id, &payload.anchor)?;
    Ok(SourcePreviewCommandResponse { preview })
}

#[tauri::command]
pub async fn chat_with_block_command(
    payload: ChatWithBlockPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    app: AppHandle,
) -> Result<ChatWithBlockCommandResponse, String> {
    let (block, model_settings) = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        let block = if let Some(block_id) = payload.block_id.as_deref() {
            Some(
                get_block(&app_state.db, block_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "知识块不存在".to_string())?,
            )
        } else {
            None
        };
        (block, app_state.config.model_settings.clone())
    };
    let system_prompt = build_chat_system_prompt();
    let prompt = build_chat_user_prompt(&block, &payload.question, &payload.history);
    let response = stream_text_completion(
        &model_settings,
        &ModelRequest {
            task_type: "reader.chat".to_string(),
            provider: model_settings.provider.clone(),
            model: model_settings.tool_model.clone(),
            system_prompt,
            prompt,
            output_format: "text".to_string(),
            context_blocks: block
                .as_ref()
                .map(|item| vec![item.content_md.clone()])
                .unwrap_or_default(),
            metadata_json: block
                .as_ref()
                .map(|item| {
                    serde_json::json!({
                        "blockId": item.block_id,
                        "documentId": item.document_id,
                        "projectId": item.project_id
                    })
                    .to_string()
                })
                .unwrap_or_else(|| "{}".to_string()),
            temperature: 0.3,
            max_output_tokens: 1200,
        },
        |chunk| {
            app.emit(
                "reader-chat-stream",
                ChatStreamEventPayload {
                    request_id: payload.request_id.clone(),
                    chunk: chunk.to_string(),
                    done: false,
                    error: None,
                },
            )
            .map_err(|error| error.to_string())
        },
    )
    .await;

    match response {
        Ok(response) => {
            app.emit(
                "reader-chat-stream",
                ChatStreamEventPayload {
                    request_id: payload.request_id,
                    chunk: String::new(),
                    done: true,
                    error: None,
                },
            )
            .map_err(|error| error.to_string())?;

            Ok(ChatWithBlockCommandResponse {
                answer: response.output_text.trim().to_string(),
                model: response.model,
                provider: response.provider,
            })
        }
        Err(error) => {
            app.emit(
                "reader-chat-stream",
                ChatStreamEventPayload {
                    request_id: payload.request_id,
                    chunk: String::new(),
                    done: true,
                    error: Some(error.clone()),
                },
            )
            .map_err(|emit_error| emit_error.to_string())?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn explain_selection_text_command(
    payload: ExplainSelectionTextPayload,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    app: AppHandle,
) -> Result<ExplainSelectionTextCommandResponse, String> {
    let selected_text = payload.selected_text.trim().to_string();
    if selected_text.is_empty() {
        return Err("选中文本不能为空".to_string());
    }
    let model_settings = {
        let app_state = state.lock().map_err(|error| error.to_string())?;
        app_state.config.model_settings.clone()
    };

    let request_id = payload.request_id.clone();
    let response = stream_text_completion(
        &model_settings,
        &ModelRequest {
            task_type: "reader.selection_paper_explain".to_string(),
            provider: model_settings.provider.clone(),
            model: model_settings.tool_model.clone(),
            system_prompt: build_selection_explain_system_prompt(),
            prompt: build_selection_explain_user_prompt(
                payload.document_id.as_deref(),
                &selected_text,
            ),
            output_format: "json".to_string(),
            context_blocks: vec![selected_text.clone()],
            metadata_json: json!({
                "documentId": payload.document_id,
                "source": "manual_selection"
            })
            .to_string(),
            temperature: 0.2,
            max_output_tokens: 1200,
        },
        |chunk| {
            app.emit(
                "reader-selection-explain-stream",
                SelectionExplainStreamEventPayload {
                    request_id: request_id.clone(),
                    chunk: chunk.to_string(),
                    done: false,
                    error: None,
                },
            )
            .map_err(|error| error.to_string())
        },
    )
    .await;

    let response = match response {
        Ok(result) => {
            app.emit(
                "reader-selection-explain-stream",
                SelectionExplainStreamEventPayload {
                    request_id: request_id.clone(),
                    chunk: String::new(),
                    done: true,
                    error: None,
                },
            )
            .map_err(|error| error.to_string())?;
            result
        }
        Err(error) => {
            app.emit(
                "reader-selection-explain-stream",
                SelectionExplainStreamEventPayload {
                    request_id,
                    chunk: String::new(),
                    done: true,
                    error: Some(error.clone()),
                },
            )
            .map_err(|emit_error| emit_error.to_string())?;
            return Err(error);
        }
    };

    let parsed = parse_selection_explain_json(&response.output_text);
    Ok(ExplainSelectionTextCommandResponse {
        summary: parsed
            .string_field(&["summary", "学习要点", "what_is_this_block_about"])
            .unwrap_or_else(|| "已基于你选择的原文完成学习解析。".to_string()),
        plain_explanation: parsed
            .string_field(&["plainExplanation", "plain_explanation", "直白解释"])
            .unwrap_or_else(|| "当前选区解释已生成。".to_string()),
        key_points: parsed.string_array_field(&[
            "keyPoints",
            "key_points",
            "重点清单",
            "最重要要点",
        ]),
        prerequisites: parsed.string_array_field(&["prerequisites", "前置知识"]),
        pitfalls: parsed.string_array_field(&["pitfalls", "常见误区"]),
        examples: parsed.string_array_field(&["examples", "理解例子"]),
        terms: parsed.term_array_field(&["terms", "术语解释", "关键术语"]),
        extension: parsed.string_array_field(&["extension", "继续拓展", "拓展"]),
        confidence: parsed
            .string_field(&["confidence"])
            .unwrap_or_else(|| "medium".to_string()),
        raw_json: response.output_text,
        model: response.model,
        provider: response.provider,
    })
}

fn build_chat_system_prompt() -> String {
    [
        "你是 KnowledgeOS 的阅读解析助手。",
        "你的任务是准确理解用户输入，并在有知识块上下文时优先基于知识块回答；没有知识块上下文时就直接和用户对话。",
        "必须遵守以下规则：",
        "1. 有知识块上下文时，只依据给定知识块和对话历史回答，不要编造未出现的事实。",
        "2. 没有知识块上下文时，把自己当作普通中文助手，直接回答用户问题。",
        "3. 优先解析用户当前输入真正想要什么，再决定回答形式。",
        "4. 如果用户没有提出额外要求且当前存在知识块，只需直接解释、拆解、翻译或梳理当前知识块内容，不要寒暄。",
        "5. 如果用户提出明确要求，例如总结、举例、类比、考试视角、科研视角、改写、提问、提炼重点，就严格按要求输出。",
        "6. 如果用户的要求和当前知识块不匹配，要明确指出边界，并在当前知识块范围内给出最接近的帮助。",
        "7. 回答使用简洁自然的中文，不要出现“根据系统提示”“根据上下文注入”之类实现细节。",
        "8. 默认输出纯文本 Markdown，可以使用短标题、列表、加粗，但不要输出 JSON。",
        "9. 不要泄露推理过程，不要解释模型行为。",
        "10. 当用户只是点击了知识块但没有具体问题，返回对该知识块的直接解析内容。"
    ]
    .join("\n")
}

fn build_selection_explain_system_prompt() -> String {
    [
        "你是 KnowledgeOS 的学习解析助手。",
        "你会收到用户在 PDF 原文中手动框选的一段文本。",
        "请仅基于该文本生成学习解析，不要编造不存在的信息。",
        "必须输出 JSON 对象，不要输出 Markdown 代码块。",
        "JSON 字段要求：",
        "summary: string，简洁说明该段核心内容",
        "plainExplanation: string，直白解释",
        "keyPoints: string[]，最多 5 条",
        "prerequisites: string[]，最多 4 条",
        "pitfalls: string[]，最多 4 条",
        "examples: string[]，最多 4 条",
        "terms: { term: string, explanation: string }[]，最多 8 条",
        "extension: string[]，最多 4 条",
        "confidence: \"high\" | \"medium\" | \"low\"",
    ]
    .join("\n")
}

fn build_selection_explain_user_prompt(document_id: Option<&str>, selected_text: &str) -> String {
    let doc = document_id.unwrap_or("unknown");
    format!("文档ID：{doc}\n\n用户手动选中的原文如下：\n---\n{selected_text}\n---\n\n请返回 JSON。")
}

struct ParsedSelectionExplainJson {
    value: Value,
}

impl ParsedSelectionExplainJson {
    fn string_field(&self, keys: &[&str]) -> Option<String> {
        for key in keys {
            if let Some(value) = self.value.get(*key).and_then(|item| item.as_str()) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }

    fn string_array_field(&self, keys: &[&str]) -> Vec<String> {
        for key in keys {
            let items = self
                .value
                .get(*key)
                .and_then(|item| item.as_array())
                .map(|array| {
                    array
                        .iter()
                        .filter_map(|item| item.as_str())
                        .map(|item| item.trim().to_string())
                        .filter(|item| !item.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !items.is_empty() {
                return items;
            }
        }
        Vec::new()
    }

    fn term_array_field(&self, keys: &[&str]) -> Vec<SelectionExplainTerm> {
        for key in keys {
            let items = self
                .value
                .get(*key)
                .and_then(|item| item.as_array())
                .map(|array| {
                    array
                        .iter()
                        .filter_map(|item| {
                            if let Some(text) = item.as_str() {
                                let normalized = text.trim();
                                if normalized.is_empty() {
                                    return None;
                                }
                                let mut parts = normalized.splitn(2, ['：', ':']);
                                let term = parts.next().unwrap_or("").trim();
                                let explanation = parts.next().unwrap_or("").trim();
                                if term.is_empty() || explanation.is_empty() {
                                    return None;
                                }
                                return Some(SelectionExplainTerm {
                                    term: term.to_string(),
                                    explanation: explanation.to_string(),
                                });
                            }
                            let term = item.get("term").and_then(|value| value.as_str())?;
                            let explanation =
                                item.get("explanation").and_then(|value| value.as_str())?;
                            let normalized_term = term.trim();
                            let normalized_explanation = explanation.trim();
                            if normalized_term.is_empty() || normalized_explanation.is_empty() {
                                return None;
                            }
                            Some(SelectionExplainTerm {
                                term: normalized_term.to_string(),
                                explanation: normalized_explanation.to_string(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !items.is_empty() {
                return items;
            }
        }
        Vec::new()
    }
}

fn parse_selection_explain_json(raw: &str) -> ParsedSelectionExplainJson {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return ParsedSelectionExplainJson { value };
    }
    let start = raw.find('{');
    let end = raw.rfind('}');
    if let (Some(start_index), Some(end_index)) = (start, end) {
        if end_index > start_index {
            let candidate = &raw[start_index..=end_index];
            if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                return ParsedSelectionExplainJson { value };
            }
        }
    }
    ParsedSelectionExplainJson { value: json!({}) }
}

fn build_chat_user_prompt(
    block: &Option<crate::services::block::BlockRecord>,
    question: &str,
    history: &[ChatHistoryItem],
) -> String {
    let history_text = if history.is_empty() {
        "无".to_string()
    } else {
        history
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(|item| format!("{}：{}", item.role, item.content))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let normalized_question = if question.trim().is_empty() {
        if block.is_some() {
            "请直接解析这个知识块。".to_string()
        } else {
            "请直接回答用户问题。".to_string()
        }
    } else {
        question.trim().to_string()
    };

    if let Some(block) = block {
        let heading_path = if block.heading_path.is_empty() {
            "无".to_string()
        } else {
            block.heading_path.join(" / ")
        };

        format!(
            "当前存在知识块上下文。\n知识块标题：{}\n标题路径：{}\n知识块正文：\n{}\n\n最近对话：\n{}\n\n用户问题：{}\n\n请直接给出最终回答。",
            block.title.as_deref().unwrap_or("未命名知识块"),
            heading_path,
            block.content_md,
            history_text,
            normalized_question
        )
    } else {
        format!(
            "当前没有知识块上下文。\n最近对话：\n{}\n\n用户问题：{}\n\n请直接给出最终回答。",
            history_text, normalized_question
        )
    }
}
