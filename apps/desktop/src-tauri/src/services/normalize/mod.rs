use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::config::AppConfig;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSection {
    pub heading: Option<String>,
    pub anchor: String,
    pub index: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedManifest {
    pub title: String,
    pub source_type: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub sections: Vec<ManifestSection>,
    #[serde(default)]
    pub assets: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeResult {
    pub ok: bool,
    pub markdown: String,
    pub manifest: NormalizedManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCleanupResponse {
    title: String,
    markdown: String,
    #[serde(default)]
    sections: Vec<AiCleanupSection>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCleanupSection {
    heading: String,
    anchor: String,
}

pub fn read_normalized_result(
    document: &crate::services::import::DocumentRecord,
) -> Result<NormalizeResult, String> {
    let markdown_path = document
        .normalized_md_path
        .clone()
        .ok_or_else(|| "文档缺少 normalized markdown 路径".to_string())?;
    let manifest_path = document
        .manifest_path
        .clone()
        .ok_or_else(|| "文档缺少 manifest 路径".to_string())?;

    let markdown = fs::read_to_string(normalize_filesystem_path(&markdown_path))
        .map_err(|error| error.to_string())?;
    let manifest_json = fs::read_to_string(normalize_filesystem_path(&manifest_path))
        .map_err(|error| error.to_string())?;
    let manifest = serde_json::from_str::<NormalizedManifest>(&manifest_json)
        .map_err(|error| error.to_string())?;

    Ok(NormalizeResult {
        ok: true,
        markdown,
        manifest,
    })
}

fn normalize_filesystem_path(path: &str) -> PathBuf {
    PathBuf::from(path.trim_start_matches(r"\\?\"))
}

pub fn refine_normalized_result(
    config: &AppConfig,
    source_type: &str,
    result: NormalizeResult,
) -> Result<NormalizeResult, String> {
    if config.model_settings.provider == "mock" {
        return Ok(result);
    }
    if should_skip_ai_cleanup(source_type, &result.markdown) {
        return Ok(result);
    }

    let prompt_path = config
        .prompt_templates_dir
        .join("import_markdown_cleanup_system.md");
    let system_prompt = fs::read_to_string(prompt_path).map_err(|error| error.to_string())?;

    let adapter = build_model_adapter(&config.model_settings)?;
    let manifest_json =
        serde_json::to_string_pretty(&result.manifest).map_err(|error| error.to_string())?;
    let prompt = format!(
        "源文档类型：{source_type}\n当前标题：{}\n当前 manifest：\n{}\n\n请整理下面这份 Markdown：\n{}",
        result.manifest.title, manifest_json, result.markdown
    );
    let response = adapter.complete(&ModelRequest {
        task_type: "import.normalize".to_string(),
        provider: config.model_settings.provider.clone(),
        model: config.model_settings.default_model.clone(),
        system_prompt,
        prompt,
        output_format: "json".to_string(),
        context_blocks: Vec::new(),
        metadata_json: "{}".to_string(),
        temperature: 0.1,
        max_output_tokens: 8000,
    })?;

    let payload: AiCleanupResponse =
        serde_json::from_str(&response.output_text).map_err(|error| error.to_string())?;
    let markdown = payload.markdown.trim().to_string();
    if markdown.is_empty() {
        return Err("AI 格式校正返回了空 Markdown".to_string());
    }
    if markdown.chars().count() < (result.markdown.chars().count() / 3).max(80) {
        return Err("AI 格式校正结果过短，已拒绝覆盖原始 Markdown".to_string());
    }

    let sections = if payload.sections.is_empty() {
        result.manifest.sections.clone()
    } else {
        payload
            .sections
            .into_iter()
            .enumerate()
            .map(|(index, section)| ManifestSection {
                heading: Some(section.heading),
                anchor: if section.anchor.trim().is_empty() {
                    format!("section-{}", index + 1)
                } else {
                    slugify_anchor(&section.anchor)
                },
                index,
            })
            .collect::<Vec<_>>()
    };

    Ok(NormalizeResult {
        ok: true,
        markdown,
        manifest: NormalizedManifest {
            title: if payload.title.trim().is_empty() {
                result.manifest.title
            } else {
                payload.title
            },
            source_type: result.manifest.source_type,
            source_path: result.manifest.source_path,
            sections,
            assets: result.manifest.assets,
            warnings: if payload.warnings.is_empty() {
                result.manifest.warnings
            } else {
                payload.warnings
            },
        },
    })
}

pub fn should_skip_ai_cleanup(source_type: &str, markdown: &str) -> bool {
    let source = source_type.to_ascii_lowercase();
    let chars = markdown.chars().count();
    let lines = markdown.lines().count();

    if source == "pdf" {
        return true;
    }
    if chars > 280_000 {
        return true;
    }
    lines > 9000
}

fn slugify_anchor(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
        } else if !character.is_ascii() {
            output.push(character);
        } else if (character.is_whitespace() || character == '-' || character == '_')
            && !output.ends_with('-')
        {
            output.push('-');
        }
    }
    output.trim_matches('-').to_string()
}

pub fn write_normalized_result(
    connection: &Connection,
    project_root: &Path,
    document_id: &str,
    result: &NormalizeResult,
) -> Result<(PathBuf, PathBuf), String> {
    let docs_dir = project_root.join("normalized").join("docs");
    let manifests_dir = project_root.join("normalized").join("manifests");
    fs::create_dir_all(&docs_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&manifests_dir).map_err(|error| error.to_string())?;

    let markdown_path = docs_dir.join(format!("{document_id}.md"));
    let manifest_path = manifests_dir.join(format!("{document_id}.json"));

    fs::write(&markdown_path, &result.markdown).map_err(|error| error.to_string())?;
    let manifest_json =
        serde_json::to_string_pretty(&result.manifest).map_err(|error| error.to_string())?;
    fs::write(&manifest_path, manifest_json).map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE documents
             SET normalized_md_path = ?1, manifest_path = ?2, title = ?3, updated_at = ?4
             WHERE document_id = ?5",
            params![
                markdown_path.to_string_lossy().into_owned(),
                manifest_path.to_string_lossy().into_owned(),
                result.manifest.title,
                Utc::now().to_rfc3339(),
                document_id
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok((markdown_path, manifest_path))
}
