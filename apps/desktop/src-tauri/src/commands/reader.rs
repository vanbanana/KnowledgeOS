use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
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
