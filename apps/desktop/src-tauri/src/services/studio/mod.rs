use std::collections::{BTreeMap, HashMap, HashSet};
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
use crate::services::graph::{UpsertRelationInput, upsert_relation};
use crate::services::import::{DocumentRecord, get_document, list_documents};
use crate::services::project::get_project;
use crate::sidecar::{enhance_graph_with_networkx, generate_presentation_pptx, parse_document};

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

#[derive(Debug, Clone)]
struct LocalGraphNode {
    id: String,
    label: String,
    node_type: String,
    weight: usize,
}

#[derive(Debug, Clone)]
struct LocalGraphRelation {
    source: String,
    target: String,
    relation_type: String,
    confidence: f64,
}

#[derive(Debug, Clone)]
struct LocalGraphBuildResult {
    nodes: Vec<LocalGraphNode>,
    relations: Vec<LocalGraphRelation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioGraphPreviewPayload {
    graph: Option<StudioGraphPreviewGraph>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioGraphPreviewGraph {
    nodes: Vec<StudioGraphPreviewNode>,
    links: Vec<StudioGraphPreviewLink>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioGraphPreviewNode {
    id: String,
    label: String,
    weight: Option<usize>,
    #[serde(default)]
    node_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioGraphPreviewLink {
    source: String,
    target: String,
    #[serde(default)]
    relation_type: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSourceSnippetRecord {
    pub document_id: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
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
    model_adapter: Option<&dyn ModelAdapter>,
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

    let (output_path, preview_json) = if matches!(
        artifact.kind.as_str(),
        "knowledge_graph" | "knowledge_graph_3d"
    ) {
        let model_adapter = model_adapter.ok_or_else(|| "图谱生成需要可用 AI 服务".to_string())?;
        let mut progress_details: Vec<String> = Vec::new();
        let mut progress_excerpt = String::new();
        let (source_bundle, used_direct_parse) = build_source_bundle_for_graph(
            connection,
            config,
            artifact_id,
            &source_documents,
            |progress_percent, stage, detail, excerpt| {
                if let Some(detail_line) = detail {
                    let cleaned = detail_line.trim();
                    if !cleaned.is_empty() {
                        progress_details.push(cleaned.to_string());
                        if progress_details.len() > 18 {
                            progress_details.remove(0);
                        }
                    }
                }
                if let Some(value) = excerpt {
                    let cleaned = value.trim();
                    if !cleaned.is_empty() {
                        progress_excerpt = cleaned.to_string();
                    }
                }
                let preview_json = build_studio_progress_preview_json(
                    &artifact.kind,
                    &stage,
                    &progress_details,
                    if progress_excerpt.is_empty() {
                        None
                    } else {
                        Some(progress_excerpt.as_str())
                    },
                )?;
                update_artifact_progress(
                    connection,
                    artifact_id,
                    "preparing",
                    progress_percent,
                    &stage,
                    None,
                    Some(&preview_json),
                )
            },
        )?;
        update_artifact_progress(
            connection,
            artifact_id,
            "preparing",
            36,
            if used_direct_parse {
                "正在直连解析 PDF 文本并提取知识点"
            } else {
                "正在用 AI 提取知识点"
            },
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
            "正在用 AI 构建图谱关系（可在下方查看实时摘要）",
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
                .take(10)
                .map(ToOwned::to_owned)
                .collect(),
            metadata_json: json!({
                "artifactId": artifact_id,
                "kind": artifact.kind,
                "projectId": artifact.project_id
            })
            .to_string(),
            temperature: 0.2,
            max_output_tokens: 3600,
        })?;

        update_artifact_progress(
            connection,
            artifact_id,
            "materializing",
            82,
            "正在写入 AI 图谱结果",
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
        update_artifact_progress(
            connection,
            artifact_id,
            "materializing",
            90,
            "正在用 NetworkX 增强图谱连通性与细粒度关系",
            None,
            None,
        )?;
        let preview_json = enhance_preview_graph_with_networkx(config, &preview_json)?;
        let synced = sync_graph_from_preview_json(
            connection,
            &artifact.project_id,
            artifact_id,
            &artifact.title,
            &preview_json,
        )?;
        if !synced {
            return Err("AI 输出未形成有效图谱结构，请检查模型返回格式".to_string());
        }
        (output_path, preview_json)
    } else if artifact.kind == "presentation" {
        let model_adapter =
            model_adapter.ok_or_else(|| "当前生成类型需要可用 AI 模型".to_string())?;
        let source_bundle = build_source_bundle(connection, &source_documents)?;
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
        let model_adapter =
            model_adapter.ok_or_else(|| "当前生成类型需要可用 AI 模型".to_string())?;
        let source_bundle = build_source_bundle(connection, &source_documents)?;
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
             SET status = 'failed',
                 current_stage = '生成失败',
                 error_message = ?1,
                 updated_at = ?2
             WHERE artifact_id = ?3",
            params![error_message, now, artifact_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn recover_interrupted_studio_artifacts(connection: &Connection) -> Result<usize, String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "UPDATE studio_artifacts
             SET status = 'failed',
                 current_stage = '生成已中断',
                 error_message = '应用重启导致上次生成任务中断，请重新发起生成',
                 updated_at = ?1
             WHERE status NOT IN ('completed', 'failed')",
            params![now],
        )
        .map_err(|error| error.to_string())
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
             WHERE artifact_id = ?7
               AND status NOT IN ('completed', 'failed')",
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

fn normalize_local_graph_label(raw: &str) -> String {
    let mut value = raw
        .replace("`", " ")
        .replace('*', " ")
        .replace('#', " ")
        .replace('>', " ")
        .replace(['[', ']', '(', ')', '{', '}'], " ")
        .replace('\t', " ")
        .replace('\r', " ")
        .replace('\n', " ");
    value = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches(['-', '—', ':', '：', '.', '。', '，', ',', ';', '；'])
        .to_string();

    if value.chars().count() > 42 {
        value = value.chars().take(42).collect::<String>();
    }
    if value.chars().count() < 2 {
        return String::new();
    }
    value
}

fn normalize_relation_type(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        "关联".to_string()
    } else {
        value.to_string()
    }
}

fn sync_local_graph_to_database(
    connection: &Connection,
    project_id: &str,
    artifact_id: &str,
    artifact_title: &str,
    graph: &LocalGraphBuildResult,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM graph_relations
             WHERE project_id = ?1 AND origin_type = 'artifact'",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM graph_nodes
             WHERE project_id = ?1 AND metadata_json LIKE '%\"generatedBy\":\"studio_local_graph\"%'",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM graph_nodes
             WHERE project_id = ?1
               AND node_type = 'concept'
               AND metadata_json LIKE '%\"studioArtifactId\":%'",
            [project_id],
        )
        .map_err(|error| error.to_string())?;

    let mut label_to_node_id: HashMap<String, String> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT node_id, label FROM graph_nodes WHERE project_id = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (node_id, label) = row.map_err(|error| error.to_string())?;
        label_to_node_id.insert(label.to_lowercase(), node_id);
    }

    let mut local_to_db: HashMap<String, String> = HashMap::new();
    let now = Utc::now().to_rfc3339();
    for node in &graph.nodes {
        let key = node.label.to_lowercase();
        if let Some(existing_node_id) = label_to_node_id.get(&key).cloned() {
            local_to_db.insert(node.id.clone(), existing_node_id);
            continue;
        }

        let node_id = Uuid::new_v4().to_string();
        let metadata_json = json!({
            "generatedBy": "studio_local_graph",
            "studioArtifactId": artifact_id,
            "studioArtifactTitle": artifact_title,
            "weight": node.weight,
            "nodeType": node.node_type
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO graph_nodes (
                    node_id, project_id, node_type, label, source_ref, metadata_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
                params![
                    node_id,
                    project_id,
                    node.node_type,
                    node.label,
                    metadata_json,
                    now,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        label_to_node_id.insert(key, node_id.clone());
        local_to_db.insert(node.id.clone(), node_id);
    }

    for relation in &graph.relations {
        let from_node_id = local_to_db.get(&relation.source).cloned();
        let to_node_id = local_to_db.get(&relation.target).cloned();
        let (Some(from_node_id), Some(to_node_id)) = (from_node_id, to_node_id) else {
            continue;
        };
        if from_node_id == to_node_id {
            continue;
        }
        let _ = upsert_relation(
            connection,
            UpsertRelationInput {
                project_id,
                from_node_id: &from_node_id,
                to_node_id: &to_node_id,
                relation_type: &relation.relation_type,
                confidence: Some(relation.confidence),
                origin_type: "artifact",
                source_ref: Some(artifact_id),
                confirmed_by_user: true,
            },
        )?;
    }

    Ok(())
}

fn sync_graph_from_preview_json(
    connection: &Connection,
    project_id: &str,
    artifact_id: &str,
    artifact_title: &str,
    preview_json: &str,
) -> Result<bool, String> {
    let Some(graph) = local_graph_from_preview_json(preview_json)? else {
        return Ok(false);
    };
    if graph.nodes.is_empty() || graph.relations.is_empty() {
        return Ok(false);
    }
    sync_local_graph_to_database(connection, project_id, artifact_id, artifact_title, &graph)?;
    Ok(true)
}

fn local_graph_from_preview_json(
    preview_json: &str,
) -> Result<Option<LocalGraphBuildResult>, String> {
    let parsed: StudioGraphPreviewPayload =
        serde_json::from_str(preview_json).map_err(|error| error.to_string())?;
    let Some(graph) = parsed.graph else {
        return Ok(None);
    };
    if graph.nodes.is_empty() || graph.links.is_empty() {
        return Ok(None);
    }

    let mut nodes = Vec::new();
    let mut node_id_set = HashSet::new();
    for node in graph.nodes {
        if node.id.trim().is_empty() {
            continue;
        }
        let label = normalize_local_graph_label(&node.label);
        if label.is_empty() {
            continue;
        }
        node_id_set.insert(node.id.clone());
        nodes.push(LocalGraphNode {
            id: node.id,
            label,
            node_type: node.node_type.unwrap_or_else(|| "concept".to_string()),
            weight: node.weight.unwrap_or(1),
        });
    }
    if nodes.is_empty() {
        return Ok(None);
    }

    let mut relation_set = HashSet::new();
    let mut relations = Vec::new();
    for link in graph.links {
        if link.source.trim().is_empty() || link.target.trim().is_empty() {
            continue;
        }
        if !node_id_set.contains(&link.source) || !node_id_set.contains(&link.target) {
            continue;
        }
        let relation_type =
            normalize_relation_type(&link.relation_type.unwrap_or_else(|| "关联".to_string()));
        let relation_key = format!("{}::{}::{}", link.source, link.target, relation_type);
        if !relation_set.insert(relation_key) {
            continue;
        }
        relations.push(LocalGraphRelation {
            source: link.source,
            target: link.target,
            relation_type,
            confidence: link.confidence.unwrap_or(0.82),
        });
    }

    if relations.is_empty() {
        return Ok(None);
    }
    Ok(Some(LocalGraphBuildResult { nodes, relations }))
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

fn build_source_bundle_for_graph<F>(
    connection: &Connection,
    config: &AppConfig,
    artifact_id: &str,
    source_documents: &[DocumentRecord],
    on_progress: F,
) -> Result<(String, bool), String>
where
    F: FnMut(i64, String, Option<String>, Option<String>) -> Result<(), String>,
{
    let mut on_progress = on_progress;
    if let Ok(bundle) = build_source_bundle(connection, source_documents) {
        let total = source_documents.len().max(1) as i64;
        let detail = format!("已读取 {total} 份资料的标准文本（normalized/blocks）");
        on_progress(30, "已完成资料来源整理".to_string(), Some(detail), None)?;
        return Ok((bundle, false));
    }

    let mut sections = Vec::new();
    let total = source_documents.len().max(1);
    for (index, document) in source_documents.iter().enumerate() {
        let document_title = document
            .title
            .clone()
            .unwrap_or_else(|| fallback_document_name(document));
        let base_progress = 12 + (((index as i64) * 20) / (total as i64));
        let stage = format!(
            "正在读取第 {}/{} 份资料：{}",
            index + 1,
            total,
            document_title
        );
        on_progress(base_progress, stage, None, None)?;

        let content = if let Ok(value) = read_document_material(connection, document) {
            let detail = format!("{}：已读取结构化文本", document_title);
            on_progress(
                base_progress + 1,
                "结构化文本读取完成".to_string(),
                Some(detail),
                None,
            )?;
            value
        } else {
            if let Some(cached_markdown) = read_graph_parse_cache(config, document) {
                let detail = format!("{}：命中本地极速文本缓存", document_title);
                on_progress(
                    base_progress + 2,
                    "已读取极速缓存文本".to_string(),
                    Some(detail),
                    Some(extract_progress_excerpt(&cached_markdown)),
                )?;
                cached_markdown
            } else {
            let temp_document_id = format!("studio-{}-{}", artifact_id, index + 1);
            let detail = format!("{}：未找到结构化文本，开始极速提取原文文本", document_title);
            on_progress(
                base_progress + 1,
                "正在极速解析 PDF 原文（PyMuPDF）".to_string(),
                Some(detail),
                None,
            )?;
            let normalized = parse_document(
                config,
                &document.source_path,
                &document.source_type,
                &temp_document_id,
            )?;
            let extracted_line_count = normalized.markdown.lines().count();
            let detail = format!(
                "{}：直连解析完成，提取 {} 行文本",
                document_title, extracted_line_count
            );
            on_progress(
                base_progress + 3,
                "原文极速解析完成".to_string(),
                Some(detail),
                Some(extract_progress_excerpt(&normalized.markdown)),
            )?;
            write_graph_parse_cache(config, document, &normalized.markdown);
            normalized.markdown
            }
        };

        let trimmed = trim_for_model(content.trim());
        if trimmed.is_empty() {
            continue;
        }
        let detail = format!(
            "{}：纳入图谱输入（约 {} 字）",
            document_title,
            trimmed.chars().count()
        );
        on_progress(
            base_progress + 5,
            "正在汇总图谱输入".to_string(),
            Some(detail),
            Some(extract_progress_excerpt(&trimmed)),
        )?;
        sections.push(format!("# 资料：{document_title}\n\n{trimmed}"));
    }

    if sections.is_empty() {
        return Err("资料尚未产生可用于图谱生成的文本内容".to_string());
    }

    on_progress(
        34,
        "资料来源整理完成，准备发送到图谱 AI".to_string(),
        Some(format!("已完成 {} 份资料聚合", sections.len())),
        None,
    )?;
    Ok((sections.join("\n\n---\n\n"), true))
}

fn extract_progress_excerpt(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(220)
        .collect::<String>()
}

fn build_studio_progress_preview_json(
    kind: &str,
    current_stage: &str,
    details: &[String],
    excerpt: Option<&str>,
) -> Result<String, String> {
    let progress = json!({
        "currentStage": current_stage,
        "details": details,
        "excerpt": excerpt.unwrap_or(""),
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let payload = json!({
        "kind": kind,
        "lineCount": 0,
        "excerpt": excerpt.unwrap_or(""),
        "progress": progress,
        "graph": serde_json::Value::Null,
        "practiceSet": serde_json::Value::Null,
        "mindMap": serde_json::Value::Null,
        "presentation": serde_json::Value::Null
    });
    serde_json::to_string(&payload).map_err(|error| error.to_string())
}

fn graph_parse_cache_path(config: &AppConfig, document: &DocumentRecord) -> PathBuf {
    let source_hash_part = document
        .source_hash
        .as_deref()
        .map(|value| value.chars().take(12).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "nohash".to_string());
    config
        .data_dir
        .join("studio_graph_cache")
        .join(format!("{}-{}.md", document.document_id, source_hash_part))
}

fn read_graph_parse_cache(config: &AppConfig, document: &DocumentRecord) -> Option<String> {
    let cache_path = graph_parse_cache_path(config, document);
    if !cache_path.exists() {
        return None;
    }
    fs::read_to_string(cache_path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_graph_parse_cache(config: &AppConfig, document: &DocumentRecord, markdown: &str) {
    let content = markdown.trim();
    if content.is_empty() {
        return;
    }
    let cache_path = graph_parse_cache_path(config, document);
    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(cache_path, content);
}

pub fn query_graph_source_snippets(
    connection: &Connection,
    config: &AppConfig,
    project_id: &str,
    artifact_id: Option<&str>,
    keyword: &str,
    limit: usize,
) -> Result<Vec<GraphSourceSnippetRecord>, String> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 12);
    let documents = resolve_graph_source_documents(connection, project_id, artifact_id)?;
    if documents.is_empty() {
        return Ok(Vec::new());
    }

    let mut snippets = Vec::<GraphSourceSnippetRecord>::new();
    for document in &documents {
        let source_text = read_graph_parse_cache(config, document)
            .or_else(|| read_document_material(connection, document).ok());
        let Some(source_text) = source_text else {
            continue;
        };
        let matches = extract_keyword_snippets_from_text(&source_text, keyword, 3);
        if matches.is_empty() {
            continue;
        }
        let title = document
            .title
            .clone()
            .unwrap_or_else(|| fallback_document_name(document));
        for (snippet, score) in matches {
            snippets.push(GraphSourceSnippetRecord {
                document_id: document.document_id.clone(),
                title: title.clone(),
                snippet,
                score,
            });
        }
    }

    snippets.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.document_id.cmp(&right.document_id))
    });

    let mut dedup = HashSet::<String>::new();
    let mut ordered = Vec::new();
    for item in snippets {
        let key = format!("{}::{}", item.document_id, item.snippet);
        if dedup.insert(key) {
            ordered.push(item);
        }
        if ordered.len() >= limit {
            break;
        }
    }

    if !ordered.is_empty() {
        return Ok(ordered);
    }

    for document in &documents {
        let source_text = read_graph_parse_cache(config, document)
            .or_else(|| read_document_material(connection, document).ok());
        let Some(source_text) = source_text else {
            continue;
        };
        let fallback_snippet = source_text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join(" ");
        if fallback_snippet.is_empty() {
            continue;
        }
        ordered.push(GraphSourceSnippetRecord {
            document_id: document.document_id.clone(),
            title: document
                .title
                .clone()
                .unwrap_or_else(|| fallback_document_name(document)),
            snippet: normalize_snippet_text(&fallback_snippet),
            score: 0.01,
        });
        if ordered.len() >= limit {
            break;
        }
    }

    Ok(ordered)
}

fn resolve_graph_source_documents(
    connection: &Connection,
    project_id: &str,
    artifact_id: Option<&str>,
) -> Result<Vec<DocumentRecord>, String> {
    let selected_artifact = if let Some(artifact_id) = artifact_id {
        get_studio_artifact(connection, artifact_id)?
    } else {
        list_studio_artifacts(connection, project_id)?
            .into_iter()
            .find(|item| {
                (item.kind == "knowledge_graph_3d" || item.kind == "knowledge_graph")
                    && item.status != "failed"
            })
    };

    let mut document_ids = Vec::<String>::new();
    if let Some(artifact) = selected_artifact {
        let ids = serde_json::from_str::<Vec<String>>(&artifact.source_document_ids_json)
            .unwrap_or_default();
        document_ids.extend(ids);
    }

    let mut documents = Vec::<DocumentRecord>::new();
    let mut seen_ids = HashSet::<String>::new();
    for document_id in document_ids {
        let Some(document) =
            get_document(connection, &document_id).map_err(|error| error.to_string())?
        else {
            continue;
        };
        if document.project_id != project_id {
            continue;
        }
        if seen_ids.insert(document.document_id.clone()) {
            documents.push(document);
        }
    }

    if !documents.is_empty() {
        return Ok(documents);
    }

    for document in list_documents(connection, project_id).map_err(|error| error.to_string())? {
        if seen_ids.insert(document.document_id.clone()) {
            documents.push(document);
        }
    }
    Ok(documents)
}

fn extract_keyword_snippets_from_text(
    text: &str,
    keyword: &str,
    max_count: usize,
) -> Vec<(String, f64)> {
    let mut snippets = Vec::<(String, f64)>::new();
    let normalized_text = text.to_lowercase();
    let normalized_keyword = keyword.to_lowercase();

    for (match_index, (byte_index, _)) in normalized_text
        .match_indices(&normalized_keyword)
        .take(max_count * 2)
        .enumerate()
    {
        let snippet = build_window_snippet(
            text,
            byte_index,
            keyword.chars().count().max(1),
            220,
        );
        if snippet.is_empty() {
            continue;
        }
        let score = 1.0 - (match_index as f64 * 0.1);
        snippets.push((snippet, score.max(0.4)));
        if snippets.len() >= max_count {
            return snippets;
        }
    }

    let tokens = keyword
        .split(|ch: char| !ch.is_alphanumeric() && ch != '+' && ch != '#')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return snippets;
    }

    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let line_lower = line.to_lowercase();
        if !tokens.iter().any(|token| line_lower.contains(&token.to_lowercase())) {
            continue;
        }
        snippets.push((normalize_snippet_text(line), 0.35));
        if snippets.len() >= max_count {
            break;
        }
    }
    snippets
}

fn build_window_snippet(
    text: &str,
    start_byte: usize,
    keyword_char_count: usize,
    window_char_count: usize,
) -> String {
    if text.is_empty() {
        return String::new();
    }
    let char_indices = text.char_indices().collect::<Vec<_>>();
    if char_indices.is_empty() {
        return String::new();
    }
    let total_chars = char_indices.len();
    let start_char_index = char_indices.partition_point(|(byte, _)| *byte < start_byte);
    let half_window = window_char_count / 2;
    let from_char_index = start_char_index.saturating_sub(half_window);
    let to_char_index = (start_char_index + keyword_char_count + half_window).min(total_chars);

    let from_byte = char_indices
        .get(from_char_index)
        .map(|(byte, _)| *byte)
        .unwrap_or(0);
    let to_byte = char_indices
        .get(to_char_index)
        .map(|(byte, _)| *byte)
        .unwrap_or(text.len());

    let mut snippet = normalize_snippet_text(&text[from_byte..to_byte]);
    if snippet.is_empty() {
        return snippet;
    }
    if from_byte > 0 {
        snippet = format!("…{snippet}");
    }
    if to_byte < text.len() {
        snippet.push('…');
    }
    snippet
}

fn normalize_snippet_text(input: &str) -> String {
    input
        .replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
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

fn enhance_preview_graph_with_networkx(
    config: &AppConfig,
    preview_json: &str,
) -> Result<String, String> {
    let mut payload: serde_json::Value =
        serde_json::from_str(preview_json).map_err(|error| error.to_string())?;
    let Some(graph_payload) = payload.get("graph").cloned() else {
        return Ok(preview_json.to_string());
    };
    if !graph_payload.is_object() {
        return Ok(preview_json.to_string());
    }

    let enhanced_graph = enhance_graph_with_networkx(config, &graph_payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("graph".to_string(), enhanced_graph);
    }
    serde_json::to_string(&payload).map_err(|error| error.to_string())
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
    let mut links: Vec<(String, String, String)> = Vec::new();
    let mut link_pair_set: HashSet<String> = HashSet::new();
    let mermaid = extract_mermaid_graph(content)?;

    for line in mermaid.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("graph ") {
            continue;
        }

        let Some((source_token, target_token, relation_type)) = extract_graph_edge(line) else {
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

        let relation_type = normalize_preview_relation_type(
            &relation_type.unwrap_or_else(|| "关联".to_string()),
        );
        let pair_key = graph_pair_key(&source_id, &target_id);
        if !link_pair_set.insert(pair_key) {
            continue;
        }
        links.push((source_id, target_id, relation_type));
    }

    if node_map.is_empty() || links.is_empty() {
        return None;
    }

    augment_graph_links(&node_map, &mut links);

    let mut degree_map: HashMap<String, usize> = HashMap::new();
    for (source, target, _) in &links {
        *degree_map.entry(source.clone()).or_insert(0) += 1;
        *degree_map.entry(target.clone()).or_insert(0) += 1;
    }

    let nodes = node_map
        .into_iter()
        .map(|(id, (label, weight))| {
            let degree = degree_map.get(&id).copied().unwrap_or(1);
            json!({
                "id": id,
                "label": label,
                "weight": weight.max(degree)
            })
        })
        .collect::<Vec<_>>();

    let links = links
        .into_iter()
        .map(|(source, target, relation_type)| {
            json!({
                "source": source,
                "target": target,
                "relationType": relation_type
            })
        })
        .collect::<Vec<_>>();

    Some(json!({
        "nodes": nodes,
        "links": links
    }))
}

fn normalize_preview_relation_type(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return "关联".to_string();
    }
    if value.contains("前置") || value.contains("依赖") {
        return "前置依赖".to_string();
    }
    if value.contains("包含") || value.contains("组成") || value.contains("属于") {
        return "包含".to_string();
    }
    if value.contains("对比") || value.contains("并列") || value.contains("区别") {
        return "并列对比".to_string();
    }
    if value.contains("实现") || value.contains("调用") {
        return "实现/调用".to_string();
    }
    if value.contains("输入") || value.contains("输出") || value.contains("参数") || value.contains("返回") {
        return "输入输出".to_string();
    }
    if value.contains("场景") || value.contains("应用") {
        return "应用场景".to_string();
    }
    if value.contains("约束") || value.contains("限制") || value.contains("边界") {
        return "约束/边界".to_string();
    }
    if value.contains("混淆") {
        return "易混淆".to_string();
    }
    if value.contains("示例") || value == "例子" {
        return "示例".to_string();
    }
    value.to_string()
}

fn graph_pair_key(left: &str, right: &str) -> String {
    if left <= right {
        format!("{left}::{right}")
    } else {
        format!("{right}::{left}")
    }
}

fn choose_component_hub(
    component: &[String],
    degree_map: &HashMap<String, usize>,
    node_map: &BTreeMap<String, (String, usize)>,
) -> Option<String> {
    component
        .iter()
        .max_by(|left, right| {
            let left_degree = degree_map.get(*left).copied().unwrap_or(0);
            let right_degree = degree_map.get(*right).copied().unwrap_or(0);
            if left_degree != right_degree {
                return left_degree.cmp(&right_degree);
            }
            let left_weight = node_map.get(*left).map(|(_, weight)| *weight).unwrap_or(0);
            let right_weight = node_map.get(*right).map(|(_, weight)| *weight).unwrap_or(0);
            if left_weight != right_weight {
                return left_weight.cmp(&right_weight);
            }
            left.cmp(right)
        })
        .cloned()
}

fn augment_graph_links(
    node_map: &BTreeMap<String, (String, usize)>,
    links: &mut Vec<(String, String, String)>,
) {
    let node_count = node_map.len();
    if node_count < 2 {
        return;
    }

    let mut adjacency: HashMap<String, Vec<String>> = node_map
        .keys()
        .cloned()
        .map(|node_id| (node_id, Vec::new()))
        .collect();
    let mut degree_map: HashMap<String, usize> = HashMap::new();
    let mut link_pair_set: HashSet<String> = HashSet::new();

    for (source, target, _) in links.iter() {
        adjacency.entry(source.clone()).or_default().push(target.clone());
        adjacency.entry(target.clone()).or_default().push(source.clone());
        *degree_map.entry(source.clone()).or_insert(0) += 1;
        *degree_map.entry(target.clone()).or_insert(0) += 1;
        link_pair_set.insert(graph_pair_key(source, target));
    }

    let mut visited: HashSet<String> = HashSet::new();
    let mut components: Vec<Vec<String>> = Vec::new();
    for node_id in node_map.keys() {
        if visited.contains(node_id) {
            continue;
        }
        let mut stack = vec![node_id.clone()];
        let mut component = Vec::new();
        visited.insert(node_id.clone());
        while let Some(current) = stack.pop() {
            component.push(current.clone());
            let neighbors = adjacency.get(&current).cloned().unwrap_or_default();
            for neighbor in neighbors {
                if visited.insert(neighbor.clone()) {
                    stack.push(neighbor);
                }
            }
        }
        components.push(component);
    }
    components.sort_by(|left, right| right.len().cmp(&left.len()));

    if components.len() > 1
        && let Some(main_hub) = choose_component_hub(&components[0], &degree_map, node_map)
    {
        for component in components.iter().skip(1) {
            let Some(component_hub) = choose_component_hub(component, &degree_map, node_map) else {
                continue;
            };
            if component_hub == main_hub {
                continue;
            }
            let pair_key = graph_pair_key(&component_hub, &main_hub);
            if !link_pair_set.insert(pair_key) {
                continue;
            }
            links.push((
                component_hub.clone(),
                main_hub.clone(),
                "关联".to_string(),
            ));
            adjacency
                .entry(component_hub.clone())
                .or_default()
                .push(main_hub.clone());
            adjacency
                .entry(main_hub.clone())
                .or_default()
                .push(component_hub.clone());
            *degree_map.entry(component_hub).or_insert(0) += 1;
            *degree_map.entry(main_hub.clone()).or_insert(0) += 1;
        }
    }

    let target_edge_count = (((node_count * 3) + 1) / 2).max(18).min(node_count * 3);
    if links.len() >= target_edge_count {
        return;
    }

    let mut hubs = node_map.keys().cloned().collect::<Vec<_>>();
    hubs.sort_by(|left, right| {
        let left_degree = degree_map.get(left).copied().unwrap_or(0);
        let right_degree = degree_map.get(right).copied().unwrap_or(0);
        right_degree.cmp(&left_degree)
    });
    hubs.truncate(3);

    let mut low_degree_nodes = node_map.keys().cloned().collect::<Vec<_>>();
    low_degree_nodes.sort_by(|left, right| {
        let left_degree = degree_map.get(left).copied().unwrap_or(0);
        let right_degree = degree_map.get(right).copied().unwrap_or(0);
        left_degree.cmp(&right_degree)
    });

    for node_id in low_degree_nodes {
        for hub in &hubs {
            if links.len() >= target_edge_count {
                return;
            }
            if &node_id == hub {
                continue;
            }
            let pair_key = graph_pair_key(&node_id, hub);
            if !link_pair_set.insert(pair_key) {
                continue;
            }
            links.push((node_id.clone(), hub.clone(), "关联".to_string()));
            *degree_map.entry(node_id.clone()).or_insert(0) += 1;
            *degree_map.entry(hub.clone()).or_insert(0) += 1;
        }
    }
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

fn extract_graph_edge(line: &str) -> Option<(&str, &str, Option<String>)> {
    if let Some(arrow_index) = line.rfind("-->") {
        let left = line[..arrow_index].trim();
        let right = line[arrow_index + 3..].trim();
        let mut target_token = right;
        let mut relation_from_right: Option<String> = None;

        if let Some(stripped) = right.strip_prefix('|')
            && let Some(pipe_end) = stripped.find('|')
        {
            let relation = stripped[..pipe_end].trim();
            let rest = stripped[pipe_end + 1..].trim();
            if !relation.is_empty() {
                relation_from_right = Some(relation.to_string());
            }
            if !rest.is_empty() {
                target_token = rest;
            }
        }

        if let Some((source, relation_token)) = left.split_once("--") {
            let relation_type = relation_token
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim();
            let relation = if relation_type.is_empty() {
                relation_from_right
            } else {
                Some(relation_type.to_string())
            };
            return Some((source.trim(), target_token, relation));
        }
        return Some((left, target_token, relation_from_right));
    }

    if let Some((source, target)) = line.split_once("---") {
        return Some((source.trim(), target.trim(), None));
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
