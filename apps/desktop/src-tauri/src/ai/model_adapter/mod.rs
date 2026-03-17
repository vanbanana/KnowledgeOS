use serde::{Deserialize, Serialize};

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
