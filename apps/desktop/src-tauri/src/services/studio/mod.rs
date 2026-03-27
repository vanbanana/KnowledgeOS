use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::ai::model_adapter::{ModelAdapter, ModelRequest};
use crate::config::AppConfig;
use crate::fs::{ensure_directory, slugify_project_name};
use crate::services::block::list_blocks;
use crate::services::import::{DocumentRecord, get_document, list_documents};
use crate::services::project::get_project;
use crate::sidecar::generate_presentation_pptx;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioArtifactRecord {
    pub artifact_id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub source_document_ids_json: String,
    pub status: String,
    pub progress_percent: i64,
    pub current_stage: Option<String>,
    pub output_path: Option<String>,
    pub preview_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct CreateStudioArtifactInput {
    pub project_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub source_document_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationDeck {
    title: String,
    subtitle: String,
    slides: Vec<PresentationSlide>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationSlide {
    title: String,
    bullets: Vec<String>,
    notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationOutline {
    theme: String,
    audience: String,
    tone: String,
    narrative: String,
    slides: Vec<PresentationOutlineSlide>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationOutlineSlide {
    title: String,
    objective: String,
    key_points: Vec<String>,
    visual_direction: String,
}

pub fn create_studio_artifact(
    connection: &Connection,
    input: CreateStudioArtifactInput,
) -> Result<StudioArtifactRecord, String> {
    if input.source_document_ids.is_empty() {
        return Err("至少选择一个资料后才能生成".to_string());
    }

    let project = get_project(connection, &input.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let now = Utc::now().to_rfc3339();
    let artifact_id = Uuid::new_v4().to_string();
    let title = input
        .title
        .unwrap_or_else(|| build_default_title(&input.kind));
    let source_document_ids_json =
        serde_json::to_string(&input.source_document_ids).map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO studio_artifacts (
                artifact_id, project_id, kind, title, source_document_ids_json, status,
                progress_percent, current_stage, output_path, preview_json, error_message,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, '等待开始生成', NULL, NULL, NULL, ?6, ?7)",
            params![
                artifact_id,
                project.project_id,
                input.kind,
                title,
                source_document_ids_json,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;

    get_studio_artifact(connection, &artifact_id)?.ok_or_else(|| "创建 Studio 产物失败".to_string())
}

pub fn list_studio_artifacts(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<StudioArtifactRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT artifact_id, project_id, kind, title, source_document_ids_json, status,
                    progress_percent, current_stage, output_path, preview_json, error_message,
                    created_at, updated_at
             FROM studio_artifacts
             WHERE project_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], map_studio_artifact_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn get_studio_artifact(
    connection: &Connection,
    artifact_id: &str,
) -> Result<Option<StudioArtifactRecord>, String> {
    connection
        .prepare(
            "SELECT artifact_id, project_id, kind, title, source_document_ids_json, status,
                    progress_percent, current_stage, output_path, preview_json, error_message,
                    created_at, updated_at
             FROM studio_artifacts
             WHERE artifact_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([artifact_id], map_studio_artifact_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn generate_studio_artifact(
    connection: &Connection,
    config: &AppConfig,
    artifact_id: &str,
    model_adapter: &dyn ModelAdapter,
) -> Result<StudioArtifactRecord, String> {
    let artifact = get_studio_artifact(connection, artifact_id)?
        .ok_or_else(|| "Studio 产物不存在".to_string())?;
    let project = get_project(connection, &artifact.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let source_document_ids: Vec<String> = serde_json::from_str(&artifact.source_document_ids_json)
        .map_err(|error| error.to_string())?;

    update_artifact_progress(
        connection,
        artifact_id,
        "preparing",
        8,
        "正在整理资料来源",
        None,
        None,
    )?;
    let source_documents =
        load_source_documents(connection, &project.project_id, &source_document_ids)?;
    let source_bundle = build_source_bundle(connection, &source_documents)?;

    let (output_path, preview_json) = if artifact.kind == "presentation" {
        update_artifact_progress(
            connection,
            artifact_id,
            "preparing",
            24,
            "正在规划演示主题",
            None,
            None,
        )?;
        let outline = generate_presentation_outline(
            config,
            model_adapter,
            artifact_id,
            &artifact.project_id,
            &artifact.title,
            &source_documents,
            &source_bundle,
        )?;

        update_artifact_progress(
            connection,
            artifact_id,
            "generating",
            64,
            "正在生成幻灯片内容",
            None,
            None,
        )?;
        let deck = generate_presentation_deck(
            config,
            model_adapter,
            artifact_id,
            &artifact.project_id,
            &artifact.title,
            &source_documents,
            &source_bundle,
            &outline,
        )?;

        update_artifact_progress(
            connection,
            artifact_id,
            "materializing",
            86,
            "正在生成 PPTX 文件",
            None,
            None,
        )?;
        materialize_presentation_artifact(config, &project.root_path, &artifact.title, &deck)?
    } else {
        update_artifact_progress(
            connection,
            artifact_id,
            "preparing",
            24,
            "正在分析资料结构",
            None,
            None,
        )?;
        let system_prompt = load_studio_prompt(config, &artifact.kind)?;
        let prompt = build_generation_prompt(
            &artifact.kind,
            &artifact.title,
            &source_documents,
            &source_bundle,
        );

        update_artifact_progress(
            connection,
            artifact_id,
            "generating",
            58,
            "正在生成内容草稿",
            None,
            None,
        )?;
        let response = model_adapter.complete(&ModelRequest {
            task_type: format!("studio.generate.{}", artifact.kind),
            provider: config.model_settings.provider.clone(),
            model: config.model_settings.default_model.clone(),
            system_prompt,
            prompt,
            output_format: "text".to_string(),
            context_blocks: source_bundle
                .split("\n\n")
                .take(8)
                .map(ToOwned::to_owned)
                .collect(),
            metadata_json: json!({
                "artifactId": artifact_id,
                "kind": artifact.kind,
                "projectId": artifact.project_id
            })
            .to_string(),
            temperature: 0.2,
            max_output_tokens: 2200,
        })?;

        update_artifact_progress(
            connection,
            artifact_id,
            "materializing",
            82,
            "正在写入生成结果",
            None,
            None,
        )?;
        let output_path = write_artifact_output(
            &project.root_path,
            &artifact.kind,
            &artifact.title,
            &response.output_text,
        )?;
        let preview_json = build_preview_json(&artifact.kind, &response.output_text)?;
        (output_path, preview_json)
    };

    update_artifact_progress(
        connection,
        artifact_id,
        "completed",
        100,
        "生成完成",
        Some(&output_path.to_string_lossy()),
        Some(&preview_json),
    )?;

    get_studio_artifact(connection, artifact_id)?.ok_or_else(|| "读取 Studio 产物失败".to_string())
}

pub fn mark_studio_artifact_failed(
    connection: &Connection,
    artifact_id: &str,
    error_message: &str,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE studio_artifacts
             SET status = 'failed', current_stage = '生成失败', error_message = ?1, updated_at = ?2
             WHERE artifact_id = ?3",
            params![error_message, now, artifact_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn update_artifact_progress(
    connection: &Connection,
    artifact_id: &str,
    status: &str,
    progress_percent: i64,
    current_stage: &str,
    output_path: Option<&str>,
    preview_json: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE studio_artifacts
             SET status = ?1,
                 progress_percent = ?2,
                 current_stage = ?3,
                 output_path = COALESCE(?4, output_path),
                 preview_json = COALESCE(?5, preview_json),
                 error_message = CASE WHEN ?1 = 'failed' THEN error_message ELSE NULL END,
                 updated_at = ?6
             WHERE artifact_id = ?7",
            params![
                status,
                progress_percent,
                current_stage,
                output_path,
                preview_json,
                now,
                artifact_id
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_source_documents(
    connection: &Connection,
    project_id: &str,
    source_document_ids: &[String],
) -> Result<Vec<DocumentRecord>, String> {
    let existing_documents =
        list_documents(connection, project_id).map_err(|error| error.to_string())?;
    let mut documents = Vec::new();
    for document_id in source_document_ids {
        let document = existing_documents
            .iter()
            .find(|item| item.document_id == *document_id)
            .cloned()
            .or_else(|| get_document(connection, document_id).ok().flatten())
            .ok_or_else(|| format!("找不到资料：{document_id}"))?;
        documents.push(document);
    }
    Ok(documents)
}

fn build_source_bundle(
    connection: &Connection,
    source_documents: &[DocumentRecord],
) -> Result<String, String> {
    let mut sections = Vec::new();
    for document in source_documents {
        let content = read_document_material(connection, document)?;
        sections.push(format!(
            "# 资料：{}\n\n{}",
            document
                .title
                .clone()
                .unwrap_or_else(|| fallback_document_name(document)),
            trim_for_model(&content)
        ));
    }
    Ok(sections.join("\n\n---\n\n"))
}

fn read_document_material(
    connection: &Connection,
    document: &DocumentRecord,
) -> Result<String, String> {
    if let Some(path) = document.normalized_md_path.as_deref() {
        let normalized_path = normalize_path(path);
        if normalized_path.exists() {
            return fs::read_to_string(normalized_path).map_err(|error| error.to_string());
        }
    }

    if matches!(document.source_type.as_str(), "md" | "txt") {
        let source_path = normalize_path(&document.source_path);
        if source_path.exists() {
            return fs::read_to_string(source_path).map_err(|error| error.to_string());
        }
    }

    let blocks =
        list_blocks(connection, &document.document_id).map_err(|error| error.to_string())?;
    if !blocks.is_empty() {
        let merged = blocks
            .into_iter()
            .map(|block| block.content_md)
            .collect::<Vec<_>>()
            .join("\n\n");
        return Ok(merged);
    }

    Err(format!(
        "资料 {} 当前还没有可用于生成的内容",
        document
            .title
            .clone()
            .unwrap_or_else(|| fallback_document_name(document))
    ))
}

fn build_generation_prompt(
    kind: &str,
    title: &str,
    source_documents: &[DocumentRecord],
    source_bundle: &str,
) -> String {
    let source_titles = source_documents
        .iter()
        .map(|document| {
            document
                .title
                .clone()
                .unwrap_or_else(|| fallback_document_name(document))
        })
        .collect::<Vec<_>>()
        .join("、");

    format!(
        "当前生成任务：{kind}\n产物标题：{title}\n资料数量：{}\n资料名称：{source_titles}\n\n请严格基于下面资料内容生成最终结果，不要编造资料里没有的信息。\n\n{source_bundle}",
        source_documents.len()
    )
}

fn generate_presentation_outline(
    config: &AppConfig,
    model_adapter: &dyn ModelAdapter,
    artifact_id: &str,
    project_id: &str,
    title: &str,
    source_documents: &[DocumentRecord],
    source_bundle: &str,
) -> Result<PresentationOutline, String> {
    let system_prompt =
        load_studio_prompt_by_file(config, "studio_presentation_outline_system.md")?;
    let prompt = build_presentation_outline_prompt(title, source_documents, source_bundle);
    let response = model_adapter.complete(&ModelRequest {
        task_type: "studio.generate.presentation.outline".to_string(),
        provider: config.model_settings.provider.clone(),
        model: config.model_settings.default_model.clone(),
        system_prompt,
        prompt,
        output_format: "text".to_string(),
        context_blocks: source_bundle
            .split("\n\n")
            .take(10)
            .map(ToOwned::to_owned)
            .collect(),
        metadata_json: json!({
            "artifactId": artifact_id,
            "kind": "presentation_outline",
            "projectId": project_id
        })
        .to_string(),
        temperature: 0.15,
        max_output_tokens: 1800,
    })?;
    parse_presentation_outline(title, &response.output_text)
}

fn generate_presentation_deck(
    config: &AppConfig,
    model_adapter: &dyn ModelAdapter,
    artifact_id: &str,
    project_id: &str,
    title: &str,
    source_documents: &[DocumentRecord],
    source_bundle: &str,
    outline: &PresentationOutline,
) -> Result<PresentationDeck, String> {
    let system_prompt = load_studio_prompt(config, "presentation")?;
    let prompt = build_presentation_deck_prompt(title, source_documents, source_bundle, outline)?;
    let response = model_adapter.complete(&ModelRequest {
        task_type: "studio.generate.presentation.deck".to_string(),
        provider: config.model_settings.provider.clone(),
        model: config.model_settings.default_model.clone(),
        system_prompt,
        prompt,
        output_format: "text".to_string(),
        context_blocks: source_bundle
            .split("\n\n")
            .take(10)
            .map(ToOwned::to_owned)
            .collect(),
        metadata_json: json!({
            "artifactId": artifact_id,
            "kind": "presentation",
            "projectId": project_id,
            "theme": outline.theme
        })
        .to_string(),
        temperature: 0.2,
        max_output_tokens: 2800,
    })?;
    parse_presentation_deck(title, &response.output_text)
}

fn build_presentation_outline_prompt(
    title: &str,
    source_documents: &[DocumentRecord],
    source_bundle: &str,
) -> String {
    let source_titles = source_documents
        .iter()
        .map(|document| {
            document
                .title
                .clone()
                .unwrap_or_else(|| fallback_document_name(document))
        })
        .collect::<Vec<_>>()
        .join("、");

    format!(
        "当前任务：为一份正式演示文稿先规划大纲。\n演示标题：{title}\n资料数量：{}\n资料名称：{source_titles}\n\n请先提炼适合 PPT 阅读的主题、受众、叙事主线与分页结构，再输出大纲 JSON。\n\n{source_bundle}",
        source_documents.len()
    )
}

fn build_presentation_deck_prompt(
    title: &str,
    source_documents: &[DocumentRecord],
    source_bundle: &str,
    outline: &PresentationOutline,
) -> Result<String, String> {
    let source_titles = source_documents
        .iter()
        .map(|document| {
            document
                .title
                .clone()
                .unwrap_or_else(|| fallback_document_name(document))
        })
        .collect::<Vec<_>>()
        .join("、");
    let outline_json = serde_json::to_string_pretty(outline).map_err(|error| error.to_string())?;

    Ok(format!(
        "当前任务：基于既定演示大纲，生成最终 PPT 页面内容 JSON。\n演示标题：{title}\n资料名称：{source_titles}\n\n先严格遵循下面这份大纲，不要退化成简单标题加文字堆砌。每一页都要有明确阅读重点、适合展示的表达方式，并保持统一主题感。\n\n演示大纲：\n{outline_json}\n\n原始资料：\n{source_bundle}"
    ))
}

fn parse_presentation_deck(default_title: &str, raw: &str) -> Result<PresentationDeck, String> {
    let trimmed = raw.trim();
    for candidate in presentation_json_candidates(trimmed) {
        if let Ok(deck) = serde_json::from_str::<PresentationDeck>(&candidate) {
            return normalize_presentation_deck(default_title, deck);
        }
    }
    Err("演示文稿生成结果不是合法的 JSON 结构".to_string())
}

fn parse_presentation_outline(
    default_title: &str,
    raw: &str,
) -> Result<PresentationOutline, String> {
    let trimmed = raw.trim();
    for candidate in presentation_json_candidates(trimmed) {
        if let Ok(outline) = serde_json::from_str::<PresentationOutline>(&candidate) {
            return normalize_presentation_outline(default_title, outline);
        }
    }
    Err("演示文稿大纲结果不是合法的 JSON 结构".to_string())
}

fn presentation_json_candidates(raw: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if !raw.is_empty() {
        candidates.push(raw.to_string());
    }

    if let Some(json_block) = extract_fenced_block(raw, "json") {
        candidates.push(json_block);
    }

    if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}'))
        && end > start
    {
        candidates.push(raw[start..=end].to_string());
    }

    candidates
}

fn extract_fenced_block(raw: &str, language: &str) -> Option<String> {
    let fence = format!("```{language}");
    let start = raw.find(&fence)?;
    let rest = &raw[start + fence.len()..];
    let end = rest.find("```")?;
    Some(rest[..end].trim().to_string())
}

fn normalize_presentation_deck(
    default_title: &str,
    deck: PresentationDeck,
) -> Result<PresentationDeck, String> {
    let title = if deck.title.trim().is_empty() {
        default_title.trim().to_string()
    } else {
        deck.title.trim().to_string()
    };
    let subtitle = deck.subtitle.trim().to_string();
    let slides = deck
        .slides
        .into_iter()
        .enumerate()
        .map(|(index, slide)| PresentationSlide {
            title: if slide.title.trim().is_empty() {
                format!("第 {} 页", index + 1)
            } else {
                slide.title.trim().to_string()
            },
            bullets: slide
                .bullets
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .take(6)
                .collect(),
            notes: slide.notes.trim().to_string(),
        })
        .collect::<Vec<_>>();

    if slides.is_empty() {
        return Err("演示文稿至少需要一页幻灯片".to_string());
    }

    Ok(PresentationDeck {
        title,
        subtitle,
        slides,
    })
}

fn normalize_presentation_outline(
    default_title: &str,
    outline: PresentationOutline,
) -> Result<PresentationOutline, String> {
    let theme = if outline.theme.trim().is_empty() {
        default_title.trim().to_string()
    } else {
        outline.theme.trim().to_string()
    };
    let audience = if outline.audience.trim().is_empty() {
        "通用业务读者".to_string()
    } else {
        outline.audience.trim().to_string()
    };
    let tone = if outline.tone.trim().is_empty() {
        "清晰、专业、适合演示".to_string()
    } else {
        outline.tone.trim().to_string()
    };
    let narrative = if outline.narrative.trim().is_empty() {
        "从背景到重点，再到总结".to_string()
    } else {
        outline.narrative.trim().to_string()
    };
    let slides = outline
        .slides
        .into_iter()
        .enumerate()
        .map(|(index, slide)| PresentationOutlineSlide {
            title: if slide.title.trim().is_empty() {
                format!("第 {} 页", index + 1)
            } else {
                slide.title.trim().to_string()
            },
            objective: if slide.objective.trim().is_empty() {
                "传达该页核心重点".to_string()
            } else {
                slide.objective.trim().to_string()
            },
            key_points: slide
                .key_points
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .take(5)
                .collect(),
            visual_direction: if slide.visual_direction.trim().is_empty() {
                "重点结论页".to_string()
            } else {
                slide.visual_direction.trim().to_string()
            },
        })
        .collect::<Vec<_>>();

    if slides.len() < 5 {
        return Err("演示文稿大纲页数过少，无法形成完整演示结构".to_string());
    }

    Ok(PresentationOutline {
        theme,
        audience,
        tone,
        narrative,
        slides,
    })
}

fn materialize_presentation_artifact(
    config: &AppConfig,
    project_root: &str,
    title: &str,
    deck: &PresentationDeck,
) -> Result<(PathBuf, String), String> {
    let output_path = build_output_path(project_root, "presentation", title, "pptx")?;
    let presentation_json = serde_json::to_string(deck).map_err(|error| error.to_string())?;
    generate_presentation_pptx(config, &output_path.to_string_lossy(), &presentation_json)?;
    let preview_json = build_presentation_preview_json(deck)?;
    Ok((output_path, preview_json))
}

fn write_artifact_output(
    project_root: &str,
    kind: &str,
    title: &str,
    content: &str,
) -> Result<PathBuf, String> {
    let output_path = build_output_path(project_root, kind, title, "md")?;
    fs::write(&output_path, content).map_err(|error| error.to_string())?;
    Ok(output_path)
}

fn build_output_path(
    project_root: &str,
    kind: &str,
    title: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_root);
    let directory = root.join("exports").join("studio").join(kind);
    ensure_directory(&directory).map_err(|error| error.to_string())?;
    let file_name = format!(
        "{}-{}.{}",
        slugify_project_name(title),
        &Uuid::new_v4().to_string()[..8],
        extension
    );
    Ok(directory.join(file_name))
}

fn build_preview_json(kind: &str, content: &str) -> Result<String, String> {
    let graph_preview = if matches!(kind, "knowledge_graph" | "knowledge_graph_3d") {
        build_graph_preview(content)
    } else {
        None
    };
    let practice_preview = if kind == "practice_set" {
        build_practice_preview(content)
    } else {
        None
    };
    let mind_map_preview = if kind == "mind_map" {
        build_mind_map_preview(content)
    } else {
        None
    };
    let presentation_preview = if kind == "presentation" {
        build_presentation_preview(content)
    } else {
        None
    };
    let preview = json!({
        "kind": kind,
        "excerpt": content.lines().take(8).collect::<Vec<_>>().join("\n"),
        "lineCount": content.lines().count(),
        "graph": graph_preview,
        "practiceSet": practice_preview,
        "mindMap": mind_map_preview,
        "presentation": presentation_preview
    });
    serde_json::to_string(&preview).map_err(|error| error.to_string())
}

fn build_presentation_preview_json(deck: &PresentationDeck) -> Result<String, String> {
    let preview = json!({
        "kind": "presentation",
        "excerpt": deck.slides.iter().take(4).map(|slide| slide.title.clone()).collect::<Vec<_>>().join("\n"),
        "lineCount": deck.slides.len(),
        "graph": serde_json::Value::Null,
        "practiceSet": serde_json::Value::Null,
        "mindMap": serde_json::Value::Null,
        "presentation": {
            "slides": deck.slides.iter().map(|slide| {
                json!({
                    "title": slide.title,
                    "lines": slide.bullets
                })
            }).collect::<Vec<_>>()
        }
    });
    serde_json::to_string(&preview).map_err(|error| error.to_string())
}

fn build_graph_preview(content: &str) -> Option<serde_json::Value> {
    let mut node_map: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut links = Vec::new();
    let mermaid = extract_mermaid_graph(content)?;

    for line in mermaid.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("graph ") {
            continue;
        }

        let Some((source_token, target_token)) = extract_graph_edge(line) else {
            continue;
        };
        let (source_id, source_label) = parse_graph_node(source_token);
        let (target_id, target_label) = parse_graph_node(target_token);
        if source_id.is_empty()
            || target_id.is_empty()
            || is_invalid_graph_label(&source_label)
            || is_invalid_graph_label(&target_label)
        {
            continue;
        }

        node_map
            .entry(source_id.clone())
            .and_modify(|entry| entry.1 += 1)
            .or_insert((source_label, 1));
        node_map
            .entry(target_id.clone())
            .and_modify(|entry| entry.1 += 1)
            .or_insert((target_label, 1));

        links.push(json!({
            "source": source_id,
            "target": target_id
        }));
    }

    if node_map.is_empty() || links.is_empty() {
        return None;
    }

    let nodes = node_map
        .into_iter()
        .map(|(id, (label, weight))| {
            json!({
                "id": id,
                "label": label,
                "weight": weight
            })
        })
        .collect::<Vec<_>>();

    Some(json!({
        "nodes": nodes,
        "links": links
    }))
}

fn extract_mermaid_graph(content: &str) -> Option<&str> {
    let start = content.find("```mermaid")?;
    let rest = &content[start + "```mermaid".len()..];
    let end = rest.find("```")?;
    Some(rest[..end].trim())
}

fn build_practice_preview(content: &str) -> Option<serde_json::Value> {
    let mut items = Vec::new();
    let mut current_type = String::new();
    let mut current_question = String::new();
    let mut current_answer = String::new();
    let mut current_explanation = String::new();
    let mut current_options: Vec<serde_json::Value> = Vec::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("## ") {
            if !current_question.is_empty() {
                items.push(json!({
                    "type": current_type.trim(),
                    "question": current_question.trim(),
                    "options": current_options,
                    "answer": current_answer.trim(),
                    "explanation": current_explanation.trim()
                }));
                current_type.clear();
                current_answer.clear();
                current_explanation.clear();
                current_options = Vec::new();
            }
            let heading = line.trim_start_matches('#').trim();
            current_type = extract_question_type(heading);
            current_question = heading.to_string();
            continue;
        }
        if let Some(question) = line.strip_prefix("题干：") {
            current_question = question.trim().to_string();
            continue;
        }
        if let Some((key, value)) = parse_option_line(line) {
            current_options.push(json!({
                "key": key,
                "label": value
            }));
            continue;
        }
        if line.starts_with("答案") {
            current_answer = line.to_string();
            continue;
        }
        if line.starts_with("解析") {
            current_explanation = line.to_string();
        }
    }

    if !current_question.is_empty() {
        items.push(json!({
            "type": current_type.trim(),
            "question": current_question.trim(),
            "options": current_options,
            "answer": current_answer.trim(),
            "explanation": current_explanation.trim()
        }));
    }

    if items.is_empty() {
        return None;
    }
    Some(json!({ "items": items }))
}

fn build_mind_map_preview(content: &str) -> Option<serde_json::Value> {
    let mermaid = extract_mermaid_graph(content).or_else(|| extract_mermaid_mindmap(content))?;
    let mut nodes: Vec<(usize, String)> = Vec::new();
    for raw_line in mermaid.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() || line.starts_with("mindmap") {
            continue;
        }
        let indent = raw_line.chars().take_while(|ch| ch.is_whitespace()).count() / 2;
        nodes.push((indent, line.trim().trim_matches('"').to_string()));
    }
    if nodes.is_empty() {
        return None;
    }
    Some(
        json!({ "nodes": nodes.into_iter().map(|(depth, label)| json!({ "depth": depth, "label": label })).collect::<Vec<_>>() }),
    )
}

fn build_presentation_preview(content: &str) -> Option<serde_json::Value> {
    let slides = content
        .split("\n---")
        .map(str::trim)
        .filter(|section| !section.is_empty())
        .map(|section| {
            let lines = section
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .take(6)
                .collect::<Vec<_>>();
            json!({
                "title": lines.first().copied().unwrap_or("未命名页"),
                "lines": lines
            })
        })
        .collect::<Vec<_>>();
    if slides.is_empty() {
        return None;
    }
    Some(json!({ "slides": slides }))
}

fn extract_mermaid_mindmap(content: &str) -> Option<&str> {
    let start = content.find("```mermaid")?;
    let rest = &content[start + "```mermaid".len()..];
    let end = rest.find("```")?;
    let candidate = rest[..end].trim();
    if candidate.lines().next()?.trim().starts_with("mindmap") {
        return Some(candidate);
    }
    None
}

fn extract_question_type(heading: &str) -> String {
    if let Some(start) = heading.find('[') {
        if let Some(end) = heading[start + 1..].find(']') {
            return heading[start + 1..start + 1 + end].trim().to_string();
        }
    }
    if heading.contains("判断题") {
        return "判断题".to_string();
    }
    if heading.contains("简答题") {
        return "简答题".to_string();
    }
    "单选题".to_string()
}

fn parse_option_line(line: &str) -> Option<(String, String)> {
    let normalized = line.trim_start_matches('-').trim();
    let mut chars = normalized.chars();
    let key = chars.next()?;
    if !matches!(key, 'A' | 'B' | 'C' | 'D') {
        return None;
    }
    let rest = chars.as_str().trim_start();
    let rest = rest.strip_prefix('.')?.trim();
    Some((key.to_string(), rest.to_string()))
}

fn extract_graph_edge(line: &str) -> Option<(&str, &str)> {
    let segments = line
        .split("-->")
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.len() >= 3 {
        let source = segments.first().copied()?;
        let target = segments.last().copied()?;
        return Some((source, target));
    }

    if let Some((source, target)) = line.split_once("-->") {
        return Some((source.trim(), target.trim()));
    }
    if let Some((source, target)) = line.split_once("---") {
        return Some((source.trim(), target.trim()));
    }
    None
}

fn parse_graph_node(token: &str) -> (String, String) {
    let cleaned = token
        .split('|')
        .next_back()
        .unwrap_or(token)
        .trim()
        .trim_matches(';');

    if let Some((id, rest)) = cleaned.split_once('[') {
        let label = rest.trim_end_matches(']').trim();
        let final_id = id.trim().to_string();
        let final_label = if label.is_empty() {
            final_id.clone()
        } else {
            label.to_string()
        };
        return (final_id, final_label);
    }

    if let Some((id, rest)) = cleaned.split_once('(') {
        let label = rest.trim_end_matches(')').trim();
        let final_id = id.trim().to_string();
        let final_label = if label.is_empty() {
            final_id.clone()
        } else {
            label.to_string()
        };
        return (final_id, final_label);
    }

    let value = cleaned.to_string();
    (value.clone(), value)
}

fn is_invalid_graph_label(label: &str) -> bool {
    let trimmed = label.trim();
    trimmed.is_empty() || trimmed.contains("-->") || trimmed.contains("->")
}

fn build_default_title(kind: &str) -> String {
    let prefix = match kind {
        "knowledge_graph" => "GraphRAG知识图谱",
        "knowledge_graph_3d" => "3D知识可视化",
        "practice_set" => "练习题草稿",
        "mind_map" => "思维导图",
        "presentation" => "演示文稿",
        _ => "Studio 产物",
    };
    format!("{prefix} {}", Utc::now().format("%m-%d %H:%M"))
}

fn fallback_document_name(document: &DocumentRecord) -> String {
    Path::new(&document.source_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(document.document_id.as_str())
        .to_string()
}

fn load_studio_prompt(config: &AppConfig, kind: &str) -> Result<String, String> {
    let file_name = match kind {
        "knowledge_graph" | "knowledge_graph_3d" => "studio_knowledge_graph_system.md",
        "practice_set" => "studio_practice_set_system.md",
        "mind_map" => "studio_mind_map_system.md",
        "presentation" => "studio_presentation_system.md",
        _ => return Err("不支持的 Studio 生成类型".to_string()),
    };
    load_studio_prompt_by_file(config, file_name)
}

fn load_studio_prompt_by_file(config: &AppConfig, file_name: &str) -> Result<String, String> {
    let prompt_path = config.prompt_templates_dir.join(file_name);
    fs::read_to_string(prompt_path).map_err(|error| error.to_string())
}

fn trim_for_model(content: &str) -> String {
    const LIMIT: usize = 18_000;
    if content.chars().count() <= LIMIT {
        return content.to_string();
    }

    content.chars().take(LIMIT).collect::<String>()
}

fn normalize_path(path: &str) -> PathBuf {
    PathBuf::from(path.trim_start_matches(r"\\?\"))
}

fn map_studio_artifact_row(
    row: &rusqlite::Row<'_>,
) -> Result<StudioArtifactRecord, rusqlite::Error> {
    Ok(StudioArtifactRecord {
        artifact_id: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        source_document_ids_json: row.get(4)?,
        status: row.get(5)?,
        progress_percent: row.get(6)?,
        current_stage: row.get(7)?,
        output_path: row.get(8)?,
        preview_json: row.get(9)?,
        error_message: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}
