use std::time::Instant;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use crate::config::ModelSettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub task_type: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub context_blocks: Vec<String>,
    #[serde(default)]
    pub metadata_json: String,
    pub temperature: f64,
    pub max_output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    pub provider: String,
    pub model: String,
    pub output_text: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub duration_ms: i64,
    pub cache_hit: bool,
}

pub trait ModelAdapter: Send + Sync {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, String>;
}

#[derive(Debug, Clone)]
pub struct MockModelAdapter;

impl ModelAdapter for MockModelAdapter {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, String> {
        let output_text = format!(
            "{{\"summary\":\"Mock explain for {}\",\"keyConcepts\":[{{\"term\":\"Block\",\"explanation\":\"当前为 mock provider 输出\"}}],\"roleInDocument\":\"当前块用于展示 Explain schema。\",\"prerequisites\":[\"基础阅读上下文\"],\"pitfalls\":[\"当前尚未接入真实模型\"],\"examples\":[\"后续此处会替换为真实模型输出\"],\"relatedCandidates\":[{{\"label\":\"知识块上下文\",\"relationHint\":\"related\",\"confidence\":0.62}}],\"mode\":\"{}\",\"promptVersion\":\"{}\"}}",
            request.task_type, "default", "explain.v1"
        );

        Ok(ModelResponse {
            provider: request.provider.clone(),
            model: request.model.clone(),
            output_text,
            input_tokens: (request.prompt.chars().count() / 4).max(1) as i64,
            output_tokens: 96,
            total_tokens: (request.prompt.chars().count() / 4).max(1) as i64 + 96,
            duration_ms: 24,
            cache_hit: false,
        })
    }
}

#[derive(Debug, Clone)]
pub struct DeepSeekModelAdapter {
    settings: ModelSettings,
    client: Client,
}

impl DeepSeekModelAdapter {
    pub fn new(settings: ModelSettings) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { settings, client })
    }
}

impl ModelAdapter for DeepSeekModelAdapter {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, String> {
        let started_at = Instant::now();
        let model_name = if request.task_type.contains("tool") || request.task_type.contains("agent") {
            self.settings.tool_model.clone()
        } else {
            self.settings.default_model.clone()
        };

        let response = self
            .client
            .post(&self.settings.api_base_url)
            .bearer_auth(&self.settings.api_key)
            .json(&serde_json::json!({
                "model": model_name,
                "messages": [
                    {
                        "role": "system",
                        "content": "你是 KnowledgeOS 的结构化模型执行层。严格遵守提示词，只输出调用方要求的内容。不要额外寒暄，不要泄露推理过程。"
                    },
                    {
                        "role": "user",
                        "content": request.prompt
                    }
                ],
                "temperature": request.temperature,
                "max_tokens": request.max_output_tokens,
                "response_format": {
                    "type": "json_object"
                }
            }))
            .send()
            .map_err(|error| format!("调用 DeepSeek API 失败: {error}"))?;

        let status = response.status();
        let body = response
            .text()
            .map_err(|error| format!("读取 DeepSeek 响应失败: {error}"))?;
        if !status.is_success() {
            return Err(format!("DeepSeek API 返回错误 {status}: {body}"));
        }

        let payload: DeepSeekChatCompletionResponse =
            serde_json::from_str(&body).map_err(|error| format!("解析 DeepSeek 响应失败: {error}"))?;
        let content = payload
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .ok_or_else(|| "DeepSeek 未返回有效内容".to_string())?;
        let usage = payload.usage.unwrap_or_default();

        Ok(ModelResponse {
            provider: self.settings.provider.clone(),
            model: payload.model,
            output_text: content,
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            duration_ms: started_at.elapsed().as_millis() as i64,
            cache_hit: false,
        })
    }
}

pub fn build_model_adapter(settings: &ModelSettings) -> Result<Box<dyn ModelAdapter>, String> {
    match settings.provider.as_str() {
        "mock" => Ok(Box::new(MockModelAdapter)),
        "deepseek" => Ok(Box::new(DeepSeekModelAdapter::new(settings.clone())?)),
        other => Err(format!("不支持的模型 provider: {other}")),
    }
}

#[derive(Debug, Deserialize)]
struct DeepSeekChatCompletionResponse {
    model: String,
    choices: Vec<DeepSeekChoice>,
    #[serde(default)]
    usage: Option<DeepSeekUsage>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekChoice {
    message: DeepSeekMessage,
}

#[derive(Debug, Deserialize)]
struct DeepSeekMessage {
    content: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DeepSeekUsage {
    #[serde(default)]
    prompt_tokens: i64,
    #[serde(default)]
    completion_tokens: i64,
    #[serde(default)]
    total_tokens: i64,
}
