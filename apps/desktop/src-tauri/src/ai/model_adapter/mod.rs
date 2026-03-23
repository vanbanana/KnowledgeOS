use std::io::Read;
use std::thread;
use std::time::{Duration, Instant};

use reqwest::{Client as AsyncClient, blocking::Client};
use serde::{Deserialize, Serialize};

use crate::config::ModelSettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub task_type: String,
    pub provider: String,
    pub model: String,
    pub system_prompt: String,
    pub prompt: String,
    pub output_format: String,
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

pub async fn stream_text_completion<F>(
    settings: &ModelSettings,
    request: &ModelRequest,
    mut on_chunk: F,
) -> Result<ModelResponse, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    match settings.provider.as_str() {
        "mock" => {
            let answer = request
                .prompt
                .lines()
                .find(|line| line.starts_with("用户问题："))
                .map(|line| line.trim_start_matches("用户问题：").trim())
                .unwrap_or("请解释当前内容");
            let output_text = format!("这是基于当前知识块的测试回复：{answer}");
            for chunk in output_text.chars().collect::<Vec<_>>().chunks(8) {
                on_chunk(&chunk.iter().collect::<String>())?;
            }
            Ok(ModelResponse {
                provider: request.provider.clone(),
                model: request.model.clone(),
                output_text,
                input_tokens: (request.prompt.chars().count() / 4).max(1) as i64,
                output_tokens: 64,
                total_tokens: (request.prompt.chars().count() / 4).max(1) as i64 + 64,
                duration_ms: 24,
                cache_hit: false,
            })
        }
        "deepseek" => stream_deepseek_text(settings, request, on_chunk).await,
        other => Err(format!("不支持的模型 provider: {other}")),
    }
}

#[derive(Debug, Clone)]
pub struct MockModelAdapter;

impl ModelAdapter for MockModelAdapter {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, String> {
        if request.output_format == "text" {
            let user_text = request
                .prompt
                .lines()
                .find(|line| line.starts_with("用户问题："))
                .map(|line| line.trim_start_matches("用户问题：").trim())
                .unwrap_or("请解释当前内容");
            return Ok(ModelResponse {
                provider: request.provider.clone(),
                model: request.model.clone(),
                output_text: format!("这是基于当前知识块的测试回复：{user_text}"),
                input_tokens: (request.prompt.chars().count() / 4).max(1) as i64,
                output_tokens: 64,
                total_tokens: (request.prompt.chars().count() / 4).max(1) as i64 + 64,
                duration_ms: 24,
                cache_hit: false,
            });
        }

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
        let payload = if request.output_format == "json" {
            serde_json::json!({
                "model": model_name,
                "messages": [
                    {
                        "role": "system",
                        "content": request.system_prompt
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
            })
        } else {
            serde_json::json!({
                "model": model_name,
                "messages": [
                    {
                        "role": "system",
                        "content": request.system_prompt
                    },
                    {
                        "role": "user",
                        "content": request.prompt
                    }
                ],
                "temperature": request.temperature,
                "max_tokens": request.max_output_tokens
            })
        };

        let mut last_error = String::new();
        let mut body = String::new();
        let mut payload_response: Option<DeepSeekChatCompletionResponse> = None;

        for attempt in 0..3 {
            let response = self
                .client
                .post(&self.settings.api_base_url)
                .header("Accept-Encoding", "identity")
                .header("Connection", "close")
                .bearer_auth(&self.settings.api_key)
                .json(&payload)
                .send()
                .map_err(|error| format!("调用 DeepSeek API 失败: {error}"))?;

            let status = response.status();
            body = read_response_body(response)?;
            if !status.is_success() {
                return Err(format!("DeepSeek API 返回错误 {status}: {body}"));
            }

            match serde_json::from_str::<DeepSeekChatCompletionResponse>(&body) {
                Ok(parsed) => {
                    payload_response = Some(parsed);
                    break;
                }
                Err(error) => {
                    last_error = format!("解析 DeepSeek 响应失败: {error}");
                    if attempt < 2 {
                        thread::sleep(Duration::from_millis(220 * (attempt + 1) as u64));
                        continue;
                    }
                }
            }
        }

        let payload = payload_response.ok_or_else(|| {
            if body.is_empty() {
                last_error.clone()
            } else {
                format!("{last_error}；响应片段：{}", trim_preview_text(&body))
            }
        })?;
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

async fn stream_deepseek_text<F>(
    settings: &ModelSettings,
    request: &ModelRequest,
    mut on_chunk: F,
) -> Result<ModelResponse, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let started_at = Instant::now();
    let client = AsyncClient::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?;
    let model_name = if request.task_type.contains("tool") || request.task_type.contains("agent") {
        settings.tool_model.clone()
    } else {
        settings.default_model.clone()
    };
    let payload = serde_json::json!({
        "model": model_name,
        "messages": [
            {
                "role": "system",
                "content": request.system_prompt
            },
            {
                "role": "user",
                "content": request.prompt
            }
        ],
        "temperature": request.temperature,
        "max_tokens": request.max_output_tokens,
        "stream": true
    });

    let mut response = client
        .post(&settings.api_base_url)
        .header("Accept-Encoding", "identity")
        .bearer_auth(&settings.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("调用 DeepSeek API 失败: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .bytes()
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|error| format!("读取 DeepSeek 响应失败: {error}"))?;
        return Err(format!("DeepSeek API 返回错误 {status}: {body}"));
    }

    let mut buffer = String::new();
    let mut output_text = String::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 DeepSeek 流失败: {error}"))?
    {
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer.drain(..=line_end);

            if !line.starts_with("data:") {
                continue;
            }

            let data = line.trim_start_matches("data:").trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                continue;
            }

            let payload: DeepSeekStreamResponse = serde_json::from_str(data)
                .map_err(|error| format!("解析 DeepSeek 流式响应失败: {error}"))?;
            let delta = payload
                .choices
                .first()
                .and_then(|choice| choice.delta.content.as_deref())
                .unwrap_or("");
            if delta.is_empty() {
                continue;
            }

            output_text.push_str(delta);
            on_chunk(delta)?;
        }
    }

    Ok(ModelResponse {
        provider: settings.provider.clone(),
        model: model_name,
        output_text,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: started_at.elapsed().as_millis() as i64,
        cache_hit: false,
    })
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

#[derive(Debug, Deserialize)]
struct DeepSeekStreamResponse {
    #[serde(default)]
    choices: Vec<DeepSeekStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekStreamChoice {
    delta: DeepSeekStreamDelta,
}

#[derive(Debug, Default, Deserialize)]
struct DeepSeekStreamDelta {
    #[serde(default)]
    content: Option<String>,
}

fn read_response_body(response: reqwest::blocking::Response) -> Result<String, String> {
    let mut response = response;
    let mut buffer = Vec::new();
    response
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取 DeepSeek 响应失败: {error}"))?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn trim_preview_text(text: &str) -> String {
    let compact = text.replace('\n', " ").replace('\r', " ");
    let trimmed = compact.trim();
    if trimmed.chars().count() > 180 {
        format!("{}...", trimmed.chars().take(180).collect::<String>())
    } else {
        trimmed.to_string()
    }
}
