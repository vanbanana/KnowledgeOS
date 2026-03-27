use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::config::AppConfig;
use crate::services::agent::tools::{is_registered_tool, tool_registry};
use crate::services::agent::{
    AGENT_STATUS_PLANNED, AgentPlan, AgentPlanStep, AgentTaskRecord, append_task_log,
    create_agent_task, save_agent_plan,
};
use crate::services::card::list_cards;
use crate::services::graph::list_nodes;
use crate::services::import::list_documents;
use crate::services::project::get_project;
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannerGrounding {
    project_id: String,
    project_name: String,
    documents: Vec<GroundedDocument>,
    cards: Vec<GroundedCard>,
    nodes: Vec<GroundedNode>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GroundedDocument {
    document_id: String,
    title: String,
    source_type: String,
    parse_status: String,
    relative_source_path: String,
    relative_normalized_md_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedCard {
    card_id: String,
    title: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedNode {
    node_id: String,
    label: String,
    node_type: String,
}

pub fn plan_agent_task(
    app_state: &AppState,
    project_id: &str,
    task_text: &str,
) -> Result<(AgentTaskRecord, AgentPlan), String> {
    let project = get_project(&app_state.db, project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let task = create_agent_task(&app_state.db, project_id, task_text, Some("agent.plan"))?;
    append_task_log(&app_state.db, &task.task_id, "info", "已创建 Agent 任务")?;

    let grounding =
        build_planner_grounding(app_state, project_id, &project.root_path, &project.name)?;
    let plan = match generate_plan_with_model(&app_state.config, task_text, &grounding) {
        Ok(plan) => sanitize_plan(plan, project_id, task_text, &grounding),
        Err(_) => build_fallback_plan(project_id, task_text, &grounding),
    };

    let task = save_agent_plan(&app_state.db, &task.task_id, &plan)?;
    append_task_log(
        &app_state.db,
        &task.task_id,
        "info",
        &format!("已生成计划，共 {} 步", plan.steps.len()),
    )?;
    if task.status == AGENT_STATUS_PLANNED {
        append_task_log(
            &app_state.db,
            &task.task_id,
            "info",
            "该任务无需额外审批，可直接执行",
        )?;
    }
    Ok((task, plan))
}

fn build_planner_grounding(
    app_state: &AppState,
    project_id: &str,
    project_root: &str,
    project_name: &str,
) -> Result<PlannerGrounding, String> {
    let root = Path::new(project_root);
    let documents = list_documents(&app_state.db, project_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|document| GroundedDocument {
            document_id: document.document_id,
            title: document.title.unwrap_or_else(|| "未命名文档".to_string()),
            source_type: document.source_type,
            parse_status: document.parse_status,
            relative_source_path: to_project_relative_path(root, &document.source_path),
            relative_normalized_md_path: document
                .normalized_md_path
                .as_deref()
                .map(|path| to_project_relative_path(root, path)),
        })
        .collect::<Vec<_>>();
    let cards = list_cards(&app_state.db, project_id)?
        .into_iter()
        .map(|card| GroundedCard {
            card_id: card.card_id,
            title: card.title,
            tags: serde_json::from_str(&card.tags_json).unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let nodes = list_nodes(&app_state.db, project_id)?
        .into_iter()
        .map(|node| GroundedNode {
            node_id: node.node_id,
            label: node.label,
            node_type: node.node_type,
        })
        .collect::<Vec<_>>();

    Ok(PlannerGrounding {
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        documents,
        cards,
        nodes,
    })
}

fn generate_plan_with_model(
    config: &AppConfig,
    task_text: &str,
    grounding: &PlannerGrounding,
) -> Result<AgentPlan, String> {
    let adapter = build_model_adapter(&config.model_settings)?;
    let prompt_path = config.prompt_templates_dir.join("agent_planner_system.md");
    let system_prompt = fs::read_to_string(prompt_path).map_err(|error| error.to_string())?;
    let tools = tool_registry()
        .into_iter()
        .map(|tool| {
            format!(
                "- {}：{}（{}）",
                tool.name,
                tool.description,
                if tool.allows_write {
                    "可写"
                } else {
                    "只读"
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let grounding_json =
        serde_json::to_string_pretty(grounding).map_err(|error| error.to_string())?;
    let prompt = format!(
        "项目名称：{}\n项目真实对象索引(JSON)：\n{}\n\n可用工具：\n{}\n\n用户任务：{}\n\n请输出严格 JSON。",
        grounding.project_name, grounding_json, tools, task_text
    );
    let response = adapter.complete(&ModelRequest {
        task_type: "agent.plan".to_string(),
        provider: config.model_settings.provider.clone(),
        model: config.model_settings.tool_model.clone(),
        system_prompt,
        prompt,
        output_format: "json".to_string(),
        context_blocks: Vec::new(),
        metadata_json: "{}".to_string(),
        temperature: 0.1,
        max_output_tokens: 2000,
    })?;
    serde_json::from_str::<AgentPlan>(&extract_json_object(&response.output_text)?)
        .map_err(|error| error.to_string())
}

fn sanitize_plan(
    mut plan: AgentPlan,
    project_id: &str,
    task_text: &str,
    grounding: &PlannerGrounding,
) -> AgentPlan {
    plan.planner_version = if plan.planner_version.trim().is_empty() {
        "agent-plan.v1".to_string()
    } else {
        plan.planner_version
    };
    plan.requires_approval = true;
    plan.steps
        .retain(|step| is_registered_tool(&step.tool_name));

    let mut last_document_id: Option<String> = None;
    let mut last_generated_path: Option<String> = None;
    for step in &mut plan.steps {
        if !step
            .target_refs
            .iter()
            .any(|target| target == &format!("project:{project_id}"))
        {
            step.target_refs.insert(0, format!("project:{project_id}"));
        }

        let resolved_document_id = resolve_step_arguments(
            step,
            task_text,
            grounding,
            last_document_id.as_deref(),
            last_generated_path.as_deref(),
        );
        if let Some(document_id) = resolved_document_id {
            last_document_id = Some(document_id.clone());
            let target_ref = format!("document:{document_id}");
            if !step.target_refs.iter().any(|item| item == &target_ref) {
                step.target_refs.push(target_ref);
            }
        }
        if step.tool_name == "update_markdown" {
            let args = parse_step_arguments(&step.arguments_json);
            if let Some(path) = args.get("path").and_then(Value::as_str) {
                last_generated_path = Some(normalize_relative_output_path(path));
            }
        }
    }

    if plan.steps.is_empty() {
        build_fallback_plan(project_id, task_text, grounding)
    } else {
        plan
    }
}

fn resolve_step_arguments(
    step: &mut AgentPlanStep,
    task_text: &str,
    grounding: &PlannerGrounding,
    last_document_id: Option<&str>,
    last_generated_path: Option<&str>,
) -> Option<String> {
    let mut args = parse_step_arguments(&step.arguments_json);
    let mut resolved_document_id = last_document_id.map(|value| value.to_string());

    match step.tool_name.as_str() {
        "read_project_tree" => {
            if args.get("path").and_then(Value::as_str).is_none() {
                args.insert("path".to_string(), Value::String("source".to_string()));
            }
        }
        "read_document" => {
            if let Some(document) =
                resolve_document_reference(&args, step, task_text, grounding, last_document_id)
            {
                args.insert(
                    "documentId".to_string(),
                    Value::String(document.document_id.clone()),
                );
                args.insert(
                    "path".to_string(),
                    Value::String(document.relative_source_path.clone()),
                );
                resolved_document_id = Some(document.document_id.clone());
            } else if args.get("path").and_then(Value::as_str).is_none()
                && let Some(path) = last_generated_path
            {
                args.insert("path".to_string(), Value::String(path.to_string()));
            }
        }
        "rename_file" | "move_file" | "delete_file" => {
            if let Some(document) =
                resolve_document_reference(&args, step, task_text, grounding, last_document_id)
            {
                args.insert(
                    "documentId".to_string(),
                    Value::String(document.document_id.clone()),
                );
                resolved_document_id = Some(document.document_id.clone());
            }
        }
        "update_markdown" => {
            if args.get("blockId").and_then(Value::as_str).is_none()
                && let Some(document) =
                    resolve_document_reference(&args, step, task_text, grounding, last_document_id)
            {
                args.insert(
                    "sourceDocumentId".to_string(),
                    Value::String(document.document_id.clone()),
                );
                resolved_document_id = Some(document.document_id.clone());
                if should_generate_content(&args) {
                    args.insert(
                        "contentMode".to_string(),
                        Value::String("generate".to_string()),
                    );
                    args.remove("content");
                    args.remove("contentMd");
                    if args.get("instruction").and_then(Value::as_str).is_none() {
                        args.insert(
                            "instruction".to_string(),
                            Value::String(build_generation_instruction(task_text)),
                        );
                    }
                    if is_missing_or_placeholder_path(args.get("path").and_then(Value::as_str)) {
                        args.insert(
                            "path".to_string(),
                            Value::String(build_generated_note_path(&document.title, task_text)),
                        );
                    } else if let Some(path) = args.get("path").and_then(Value::as_str) {
                        args.insert(
                            "path".to_string(),
                            Value::String(normalize_relative_output_path(path)),
                        );
                    }
                }
            } else if should_generate_content(&args)
                && args
                    .get("sourceDocumentId")
                    .and_then(Value::as_str)
                    .is_none()
                && args.get("sourcePath").and_then(Value::as_str).is_none()
                && let Some(path) = last_generated_path
            {
                args.insert("sourcePath".to_string(), Value::String(path.to_string()));
            }
        }
        "merge_cards" | "update_tags" => {
            resolve_card_arguments(&mut args, step, task_text, grounding);
        }
        _ => {}
    }

    step.arguments_json = Value::Object(args).to_string();
    resolved_document_id
}

fn resolve_card_arguments(
    args: &mut Map<String, Value>,
    step: &AgentPlanStep,
    task_text: &str,
    grounding: &PlannerGrounding,
) {
    if step.tool_name == "update_tags"
        && args.get("cardId").and_then(Value::as_str).is_none()
        && let Some(card_id) = resolve_card_id(grounding, &[task_text, &step.title, &step.reason])
    {
        args.insert("cardId".to_string(), Value::String(card_id));
    }

    if step.tool_name == "merge_cards" {
        if args.get("sourceCardId").and_then(Value::as_str).is_none()
            && let Some(card_id) = resolve_card_id(grounding, &[task_text, &step.title, "源卡片"])
        {
            args.insert("sourceCardId".to_string(), Value::String(card_id));
        }
        if args.get("targetCardId").and_then(Value::as_str).is_none()
            && let Some(card_id) = resolve_card_id(grounding, &[task_text, &step.title, "目标卡片"])
        {
            args.insert("targetCardId".to_string(), Value::String(card_id));
        }
    }
}

fn resolve_document_reference<'a>(
    args: &Map<String, Value>,
    step: &AgentPlanStep,
    task_text: &str,
    grounding: &'a PlannerGrounding,
    last_document_id: Option<&str>,
) -> Option<&'a GroundedDocument> {
    if let Some(document_id) = args
        .get("documentId")
        .or_else(|| args.get("sourceDocumentId"))
        .and_then(Value::as_str)
        && let Some(document) = grounding
            .documents
            .iter()
            .find(|item| item.document_id == document_id)
    {
        return Some(document);
    }

    if let Some(path) = args.get("path").and_then(Value::as_str)
        && !is_missing_or_placeholder_path(Some(path))
    {
        let normalized = normalize_reference_text(path);
        if let Some(document) = grounding.documents.iter().find(|item| {
            normalize_reference_text(&item.relative_source_path) == normalized
                || item
                    .relative_normalized_md_path
                    .as_deref()
                    .map(normalize_reference_text)
                    .as_deref()
                    == Some(normalized.as_str())
        }) {
            return Some(document);
        }
    }

    let mut search_terms = vec![task_text, &step.title, &step.reason];
    if let Some(path) = args.get("path").and_then(Value::as_str) {
        search_terms.push(path);
    }
    let resolved = resolve_document_by_terms(grounding, &search_terms, last_document_id);
    if resolved.is_some() {
        return resolved;
    }

    last_document_id.and_then(|document_id| {
        grounding
            .documents
            .iter()
            .find(|item| item.document_id == document_id)
    })
}

fn resolve_document_by_terms<'a>(
    grounding: &'a PlannerGrounding,
    terms: &[&str],
    last_document_id: Option<&str>,
) -> Option<&'a GroundedDocument> {
    let mut best: Option<(&GroundedDocument, i32)> = None;
    let mut second_best = 0;

    for document in &grounding.documents {
        let score = terms
            .iter()
            .map(|term| score_document_match(document, term))
            .sum::<i32>()
            + if last_document_id == Some(document.document_id.as_str()) {
                8
            } else {
                0
            };

        if score <= 0 {
            continue;
        }

        match best {
            Some((_, current_score)) if score > current_score => {
                second_best = current_score;
                best = Some((document, score));
            }
            Some((_, current_score)) if score > second_best && score <= current_score => {
                second_best = score;
            }
            None => best = Some((document, score)),
            _ => {}
        }
    }

    match best {
        Some((document, score)) if score >= second_best + 10 => Some(document),
        Some((document, score)) if second_best == 0 && score > 0 => Some(document),
        _ => None,
    }
}

fn score_document_match(document: &GroundedDocument, term: &str) -> i32 {
    let needle = normalize_reference_text(term);
    if needle.is_empty() {
        return 0;
    }

    let title = normalize_reference_text(&document.title);
    let source_path = normalize_reference_text(&document.relative_source_path);
    let normalized_path = document
        .relative_normalized_md_path
        .as_deref()
        .map(normalize_reference_text)
        .unwrap_or_default();

    let mut score = 0;
    for haystack in [
        title.as_str(),
        source_path.as_str(),
        normalized_path.as_str(),
    ] {
        if haystack.is_empty() {
            continue;
        }
        if haystack == needle {
            score = score.max(120);
            continue;
        }
        if haystack.contains(&needle) {
            score = score.max(90);
            continue;
        }
        if needle.contains(haystack) && haystack.chars().count() >= 3 {
            score = score.max(72);
        }
    }
    score
}

fn resolve_card_id(grounding: &PlannerGrounding, terms: &[&str]) -> Option<String> {
    let mut best: Option<(&GroundedCard, i32)> = None;
    let mut second_best = 0;

    for card in &grounding.cards {
        let title = normalize_reference_text(&card.title);
        let score = terms
            .iter()
            .map(|term| {
                let needle = normalize_reference_text(term);
                if needle.is_empty() {
                    0
                } else if title == needle {
                    120
                } else if title.contains(&needle) || needle.contains(&title) {
                    80
                } else {
                    0
                }
            })
            .sum::<i32>();
        if score <= 0 {
            continue;
        }
        match best {
            Some((_, current_score)) if score > current_score => {
                second_best = current_score;
                best = Some((card, score));
            }
            Some((_, current_score)) if score > second_best && score <= current_score => {
                second_best = score;
            }
            None => best = Some((card, score)),
            _ => {}
        }
    }

    match best {
        Some((card, score)) if score >= second_best + 10 => Some(card.card_id.clone()),
        Some((card, score)) if second_best == 0 && score > 0 => Some(card.card_id.clone()),
        _ => None,
    }
}

fn should_generate_content(args: &Map<String, Value>) -> bool {
    if args.get("contentMode").and_then(Value::as_str) == Some("generate") {
        return true;
    }
    let content = args
        .get("contentMd")
        .or_else(|| args.get("content"))
        .and_then(Value::as_str);
    match content {
        Some(value) => is_placeholder_content(value),
        None => true,
    }
}

fn is_scratch_generation_task(task_text: &str) -> bool {
    let text = task_text.trim();
    (text.contains("测试") || text.contains("示例") || text.contains("demo"))
        && (text.contains("md")
            || text.contains("markdown")
            || text.contains("文档")
            || text.contains("笔记"))
}

fn is_placeholder_content(content: &str) -> bool {
    let normalized = normalize_reference_text(content);
    normalized.is_empty()
        || (normalized.chars().count() <= 18
            && ["内容", "小结", "总结", "笔记", "整理稿", "新增"]
                .iter()
                .any(|keyword| normalized.contains(keyword)))
}

fn is_missing_or_placeholder_path(path: Option<&str>) -> bool {
    match path {
        None => true,
        Some(value) => {
            let normalized = normalize_reference_text(value);
            normalized.is_empty()
                || (!value.contains('/') && !value.contains('\\'))
                || normalized.ends_with("路径")
                || normalized.contains("文档路径")
                || normalized.contains("文件路径")
        }
    }
}

fn build_generation_instruction(task_text: &str) -> String {
    let normalized = task_text.trim();
    if normalized.is_empty() {
        "根据源文档生成一份结构清晰的 Markdown 笔记，包含标题、要点和简短总结。".to_string()
    } else if is_scratch_generation_task(normalized) {
        format!("请直接生成一篇可写入 Markdown 文件的内容，严格完成这个任务：{normalized}")
    } else {
        format!("请围绕以下用户任务生成可直接写入 Markdown 的内容：{normalized}")
    }
}

fn build_generated_note_path(document_title: &str, task_text: &str) -> String {
    if is_scratch_generation_task(task_text) {
        return "notes/test-note.md".to_string();
    }
    let suffix = if task_text.contains("小结") {
        "小结"
    } else if task_text.contains("总结") {
        "总结"
    } else if task_text.contains("笔记") {
        "笔记"
    } else {
        "整理"
    };
    format!("notes/{}-{}.md", slugify(document_title), suffix)
}

fn normalize_relative_output_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn normalize_reference_text(value: &str) -> String {
    let lower = value.to_lowercase();
    let cleaned = lower
        .replace("文档路径", "")
        .replace("文件路径", "")
        .replace("文档", "")
        .replace("文件", "")
        .replace("文章", "")
        .replace("路径", "")
        .replace("markdown", "")
        .replace(".md", "")
        .replace(".txt", "")
        .replace(".docx", "")
        .replace(".pdf", "")
        .replace(".pptx", "");
    cleaned
        .chars()
        .filter(|char| {
            char.is_alphanumeric() || !char.is_ascii_punctuation() && !char.is_whitespace()
        })
        .collect::<String>()
}

fn slugify(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|char| {
            if char.is_whitespace()
                || matches!(
                    char,
                    '/' | '\\' | ':' | '：' | '|' | '?' | '*' | '"' | '<' | '>'
                )
            {
                '-'
            } else {
                char
            }
        })
        .collect::<String>();
    let trimmed = normalized.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "agent-note".to_string()
    } else {
        trimmed
    }
}

fn parse_step_arguments(arguments_json: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(arguments_json)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn build_fallback_plan(
    project_id: &str,
    task_text: &str,
    grounding: &PlannerGrounding,
) -> AgentPlan {
    let lower = task_text.to_lowercase();
    let step = if task_text.contains("导出") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "导出当前项目".to_string(),
            tool_name: "export_project".to_string(),
            reason: "用户明确要求导出项目".to_string(),
            risk_level: "low".to_string(),
            arguments_json: "{\"targetDir\":\"exports\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if task_text.contains("标签") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "更新卡片标签".to_string(),
            tool_name: "update_tags".to_string(),
            reason: "任务文本包含标签更新诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"cardId\":\"\",\"tags\":[]}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if lower.contains("重命名") || lower.contains("rename") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "重命名项目内文件".to_string(),
            tool_name: "rename_file".to_string(),
            reason: "任务文本包含文件重命名诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"documentId\":\"\",\"newName\":\"\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if task_text.contains("删除")
        && (task_text.contains("文件") || task_text.contains("文档"))
    {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "删除项目内文件".to_string(),
            tool_name: "delete_file".to_string(),
            reason: "任务文本明确要求删除文件".to_string(),
            risk_level: "high".to_string(),
            arguments_json: "{\"documentId\":\"\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if task_text.contains("关系")
        && (task_text.contains("删除") || task_text.contains("移除"))
    {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "删除图谱关系".to_string(),
            tool_name: "remove_relation".to_string(),
            reason: "任务文本明确要求删除关系".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"relationId\":\"\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if task_text.contains("关系") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "创建图谱关系".to_string(),
            tool_name: "create_relation".to_string(),
            reason: "任务文本包含关系创建诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"fromNodeId\":\"\",\"toNodeId\":\"\",\"relationType\":\"related\"}"
                .to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if task_text.contains("卡片") && task_text.contains("合并") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "合并卡片".to_string(),
            tool_name: "merge_cards".to_string(),
            reason: "任务文本包含卡片合并诉求".to_string(),
            risk_level: "high".to_string(),
            arguments_json: "{\"sourceCardId\":\"\",\"targetCardId\":\"\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    } else if let Some(document) = resolve_document_by_terms(grounding, &[task_text], None) {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: format!("读取{}", document.title),
            tool_name: "read_document".to_string(),
            reason: "先读取目标文档，避免直接修改错误对象".to_string(),
            risk_level: "low".to_string(),
            arguments_json: format!("{{\"documentId\":\"{}\"}}", document.document_id),
            target_refs: vec![
                format!("project:{project_id}"),
                format!("document:{}", document.document_id),
            ],
        }
    } else {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "读取项目目录".to_string(),
            tool_name: "read_project_tree".to_string(),
            reason: "任务目标不够明确，先生成低风险读取步骤".to_string(),
            risk_level: "low".to_string(),
            arguments_json: "{\"path\":\"source\"}".to_string(),
            target_refs: vec![format!("project:{project_id}")],
        }
    };

    AgentPlan {
        goal: task_text.to_string(),
        summary: "已根据当前任务生成受控 Agent 计划。".to_string(),
        requires_approval: true,
        planner_version: "agent-plan.v1".to_string(),
        model_name: "fallback-planner".to_string(),
        steps: vec![step],
    }
}

fn to_project_relative_path(project_root: &Path, path: &str) -> String {
    PathBuf::from(path)
        .strip_prefix(project_root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.replace('\\', "/"))
}

fn extract_json_object(text: &str) -> Result<String, String> {
    let start = text
        .find('{')
        .ok_or_else(|| "模型未返回 JSON".to_string())?;
    let end = text
        .rfind('}')
        .ok_or_else(|| "模型未返回完整 JSON".to_string())?;
    let candidate = &text[start..=end];
    let _: Value = serde_json::from_str(candidate).map_err(|error| error.to_string())?;
    Ok(candidate.to_string())
}
