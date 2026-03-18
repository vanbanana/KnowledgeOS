use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::fs::sandbox::{assert_within_project_root, resolve_project_relative_path};
use crate::services::agent::{
    AGENT_STATUS_AWAITING_APPROVAL, AGENT_STATUS_COMPLETED, AGENT_STATUS_EXECUTING,
    AGENT_STATUS_FAILED, AgentTaskRecord, append_task_log, get_agent_task, parse_agent_plan,
    transition_agent_task_status,
};
use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::services::block::{get_block, list_blocks, update_block_metadata};
use crate::services::card::{get_card, update_card};
use crate::services::graph::{UpsertRelationInput, get_relation, remove_relation, upsert_relation};
use crate::services::import::{delete_document, get_document, list_documents};
use crate::services::project::get_project;
use crate::services::rollback::rollback_task;
use crate::services::search::rebuild_project_search_index;
use crate::services::snapshot::{
    create_file_snapshot, create_record_snapshot, snapshot_document,
};
use crate::state::AppState;

struct ExecutionContext {
    task_text: String,
    loaded_documents: HashMap<String, LoadedDocumentContext>,
}

struct LoadedDocumentContext {
    document_id: String,
    title: String,
    content_md: String,
}

pub fn confirm_and_execute(
    app_state: &AppState,
    task_id: &str,
) -> Result<AgentTaskRecord, String> {
    let task = get_agent_task(&app_state.db, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    if task.status != AGENT_STATUS_AWAITING_APPROVAL && task.status != "planned" {
        return Err("当前任务状态不能执行".to_string());
    }
    let plan = parse_agent_plan(&task)?;
    let project = get_project(&app_state.db, &task.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;

    transition_agent_task_status(&app_state.db, task_id, AGENT_STATUS_EXECUTING)?;
    append_task_log(&app_state.db, task_id, "info", "开始执行已批准计划")?;
    let mut context = ExecutionContext {
        task_text: task.task_text.clone(),
        loaded_documents: HashMap::new(),
    };

    for step in &plan.steps {
        let args: Value = serde_json::from_str(&step.arguments_json).map_err(|error| error.to_string())?;
        let result = execute_step(
            app_state,
            task_id,
            &project.project_id,
            &project.root_path,
            &step.tool_name,
            &args,
            &mut context,
        );
        if let Err(error) = result {
            append_task_log(&app_state.db, task_id, "error", &format!("步骤 {} 执行失败：{}", step.title, error))?;
            transition_agent_task_status(&app_state.db, task_id, AGENT_STATUS_FAILED)?;
            return Err(error);
        }
        append_task_log(&app_state.db, task_id, "info", &format!("已执行步骤：{}", step.title))?;
    }

    transition_agent_task_status(&app_state.db, task_id, AGENT_STATUS_COMPLETED)
}

pub fn rollback_agent_task(
    app_state: &AppState,
    task_id: &str,
) -> Result<AgentTaskRecord, String> {
    let (task, _) = rollback_task(app_state, task_id)?;
    Ok(task)
}

fn execute_step(
    app_state: &AppState,
    task_id: &str,
    project_id: &str,
    project_root: &str,
    tool_name: &str,
    args: &Value,
    context: &mut ExecutionContext,
) -> Result<(), String> {
    match tool_name {
        "read_project_tree" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
            let target = resolve_project_relative_path(Path::new(project_root), path)?;
            if !target.exists() {
                return Ok(());
            }
            let _ = fs::read_dir(target).map_err(|error| error.to_string())?;
            Ok(())
        }
        "read_document" => execute_read_document(app_state, project_id, project_root, args, context),
        "rename_file" => execute_rename_file(app_state, task_id, project_root, args),
        "move_file" => execute_move_file(app_state, task_id, project_root, args),
        "delete_file" => execute_delete_file(app_state, task_id, project_id, project_root, args),
        "update_markdown" => execute_update_markdown(app_state, task_id, project_root, args, context),
        "merge_cards" => execute_merge_cards(app_state, task_id, args),
        "update_tags" => execute_update_tags(app_state, task_id, args),
        "create_relation" => execute_create_relation(app_state, task_id, args),
        "remove_relation" => execute_remove_relation(app_state, task_id, args),
        "export_project" => execute_export_project(app_state, task_id, project_root, args),
        other => Err(format!("未实现的 Agent 工具：{other}")),
    }
}

fn execute_rename_file(app_state: &AppState, task_id: &str, project_root: &str, args: &Value) -> Result<(), String> {
    let document_id = args.get("documentId").and_then(Value::as_str).ok_or_else(|| "缺少 documentId".to_string())?;
    let new_name = args.get("newName").and_then(Value::as_str).ok_or_else(|| "缺少 newName".to_string())?;
    let document = get_document(&app_state.db, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;
    snapshot_document(&app_state.db, task_id, document_id)?;
    create_file_snapshot(
        &app_state.db,
        &app_state.config,
        task_id,
        "file",
        document_id,
        Path::new(&document.source_path),
    )?;

    let source = PathBuf::from(&document.source_path);
    let parent = source.parent().ok_or_else(|| "源文件路径无效".to_string())?;
    let target = parent.join(new_name);
    let target = resolve_project_relative_path(Path::new(project_root), &target.strip_prefix(project_root).unwrap_or(&target).to_string_lossy())?;
    assert_within_project_root(Path::new(project_root), &target)?;
    fs::rename(&source, &target).map_err(|error| error.to_string())?;

    let now = Utc::now().to_rfc3339();
    app_state
        .db
        .execute(
            "UPDATE documents SET source_path = ?1, title = ?2, updated_at = ?3 WHERE document_id = ?4",
            params![
                target.to_string_lossy().into_owned(),
                Path::new(new_name).file_stem().and_then(|value| value.to_str()),
                now,
                document_id
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn execute_move_file(app_state: &AppState, task_id: &str, project_root: &str, args: &Value) -> Result<(), String> {
    let document_id = args.get("documentId").and_then(Value::as_str).ok_or_else(|| "缺少 documentId".to_string())?;
    let target_path = args.get("targetPath").and_then(Value::as_str).ok_or_else(|| "缺少 targetPath".to_string())?;
    let document = get_document(&app_state.db, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;
    snapshot_document(&app_state.db, task_id, document_id)?;
    create_file_snapshot(
        &app_state.db,
        &app_state.config,
        task_id,
        "file",
        document_id,
        Path::new(&document.source_path),
    )?;
    let target = resolve_project_relative_path(Path::new(project_root), target_path)?;
    assert_within_project_root(Path::new(project_root), &target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(&document.source_path, &target).map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    app_state
        .db
        .execute(
            "UPDATE documents SET source_path = ?1, updated_at = ?2 WHERE document_id = ?3",
            params![target.to_string_lossy().into_owned(), now, document_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn execute_read_document(
    app_state: &AppState,
    project_id: &str,
    project_root: &str,
    args: &Value,
    context: &mut ExecutionContext,
) -> Result<(), String> {
    let document = resolve_document_for_execution(app_state, project_id, project_root, args)?
        .ok_or_else(|| "缺少 documentId 或 path，且无法定位目标文档".to_string())?;
    let content_md = load_document_content(app_state, &document.document_id)?;
    let title = document
        .title
        .clone()
        .unwrap_or_else(|| document.document_id.clone());
    context.loaded_documents.insert(
        document.document_id.clone(),
        LoadedDocumentContext {
            document_id: document.document_id.clone(),
            title,
            content_md,
        },
    );
    Ok(())
}

fn execute_delete_file(
    app_state: &AppState,
    task_id: &str,
    project_id: &str,
    project_root: &str,
    args: &Value,
) -> Result<(), String> {
    if let Some(document) = resolve_document_for_execution(app_state, project_id, project_root, args)? {
        snapshot_document_with_related_state(app_state, task_id, &document)?;
        let _ = delete_document(&app_state.db, &document.document_id, true)?;
        rebuild_project_search_index(&app_state.db, project_id)?;
        return Ok(());
    }

    let relative_path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 documentId 或 path".to_string())?;
    let target = resolve_project_relative_path(Path::new(project_root), relative_path)?;
    assert_within_project_root(Path::new(project_root), &target)?;
    if !target.exists() {
        return Err("目标文件不存在".to_string());
    }
    create_file_snapshot(
        &app_state.db,
        &app_state.config,
        task_id,
        "file",
        &target.to_string_lossy(),
        &target,
    )?;
    fs::remove_file(&target).map_err(|error| error.to_string())?;
    Ok(())
}

fn snapshot_document_with_related_state(
    app_state: &AppState,
    task_id: &str,
    document: &crate::services::import::DocumentRecord,
) -> Result<(), String> {
    snapshot_document(&app_state.db, task_id, &document.document_id)?;
    create_file_snapshot(
        &app_state.db,
        &app_state.config,
        task_id,
        "file",
        &document.document_id,
        Path::new(&document.source_path),
    )?;

    if let Some(path) = document.normalized_md_path.as_deref()
        && Path::new(path).exists()
    {
        create_file_snapshot(
            &app_state.db,
            &app_state.config,
            task_id,
            "file",
            &format!("{}:normalized", document.document_id),
            Path::new(path),
        )?;
    }

    if let Some(path) = document.manifest_path.as_deref()
        && Path::new(path).exists()
    {
        create_file_snapshot(
            &app_state.db,
            &app_state.config,
            task_id,
            "file",
            &format!("{}:manifest", document.document_id),
            Path::new(path),
        )?;
    }

    let blocks_jsonl = Path::new(&document.source_path)
        .parent()
        .and_then(Path::parent)
        .map(|project_dir| project_dir.join("blocks").join(format!("{}.jsonl", document.document_id)));
    if let Some(path) = blocks_jsonl.as_ref()
        && path.exists()
    {
        create_file_snapshot(
            &app_state.db,
            &app_state.config,
            task_id,
            "file",
            &format!("{}:blocks", document.document_id),
            path,
        )?;
    }

    let blocks = list_blocks(&app_state.db, &document.document_id).map_err(|error| error.to_string())?;
    for block in blocks {
        create_record_snapshot(&app_state.db, task_id, "block", &block.block_id, Some(&block))?;
    }

    Ok(())
}

fn execute_update_markdown(
    app_state: &AppState,
    task_id: &str,
    project_root: &str,
    args: &Value,
    context: &mut ExecutionContext,
) -> Result<(), String> {
    if let Some(block_id) = args.get("blockId").and_then(Value::as_str) {
        let content_md = args
            .get("contentMd")
            .or_else(|| args.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(|| "缺少 contentMd 或 content".to_string())?;
        let block = get_block(&app_state.db, block_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "块不存在".to_string())?;
        create_record_snapshot(&app_state.db, task_id, "block", block_id, Some(&block))?;
        update_block_metadata(&app_state.db, block_id, None, None, block.title.as_deref(), Some(content_md))?;
        return Ok(());
    }

    let task = get_agent_task(&app_state.db, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    let project = get_project(&app_state.db, &task.project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let task_text = context.task_text.clone();
    let content_md = if args.get("contentMode").and_then(Value::as_str) == Some("generate") {
        let instruction = args
            .get("instruction")
            .and_then(Value::as_str)
            .ok_or_else(|| "生成内容步骤缺少 instruction".to_string())?;
        let resolved_source_document = resolve_document_for_execution(
            app_state,
            &task.project_id,
            project_root,
            args,
        )?;
        let source_document_id_owned = args
            .get("sourceDocumentId")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .or_else(|| resolved_source_document.as_ref().map(|document| document.document_id.clone()));
        let source_document_id = source_document_id_owned.as_deref();
        append_task_log(
            &app_state.db,
            task_id,
            "info",
            &match source_document_id {
                Some(document_id) => format!("开始基于文档 {} 生成 Markdown 内容", document_id),
                None => "开始生成新的 Markdown 内容".to_string(),
            },
        )?;
        generate_markdown_content(
            app_state,
            source_document_id,
            instruction,
            &task_text,
            context,
        )?
    } else {
        args.get("contentMd")
            .or_else(|| args.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(|| "缺少 contentMd 或 content".to_string())?
            .to_string()
    };
    let relative_path = args.get("path").and_then(Value::as_str).ok_or_else(|| "缺少 blockId 或 path".to_string())?;
    let target = resolve_project_relative_path(Path::new(project_root), relative_path)?;
    assert_within_project_root(Path::new(&project.root_path), &target)?;
    if target.exists() {
        create_file_snapshot(
            &app_state.db,
            &app_state.config,
            task_id,
            "file",
            &target.to_string_lossy(),
            &target,
        )?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, &content_md).map_err(|error| error.to_string())?;
    upsert_generated_markdown_document(app_state, task_id, &task.project_id, &target, &content_md)?;
    Ok(())
}

fn execute_merge_cards(app_state: &AppState, task_id: &str, args: &Value) -> Result<(), String> {
    let source_card_id = args.get("sourceCardId").and_then(Value::as_str).ok_or_else(|| "缺少 sourceCardId".to_string())?;
    let target_card_id = args.get("targetCardId").and_then(Value::as_str).ok_or_else(|| "缺少 targetCardId".to_string())?;
    let source_card = get_card(&app_state.db, source_card_id)?.ok_or_else(|| "源卡片不存在".to_string())?;
    let target_card = get_card(&app_state.db, target_card_id)?.ok_or_else(|| "目标卡片不存在".to_string())?;
    create_record_snapshot(&app_state.db, task_id, "card", source_card_id, Some(&source_card))?;
    create_record_snapshot(&app_state.db, task_id, "card", target_card_id, Some(&target_card))?;
    let merged_content = format!("{}\n\n---\n\n{}", target_card.content_md, source_card.content_md);
    let mut tags = serde_json::from_str::<Vec<String>>(&target_card.tags_json).unwrap_or_default();
    tags.extend(serde_json::from_str::<Vec<String>>(&source_card.tags_json).unwrap_or_default());
    tags.sort();
    tags.dedup();
    update_card(&app_state.db, target_card_id, &target_card.title, &merged_content, tags)?;
    app_state
        .db
        .execute("DELETE FROM cards WHERE card_id = ?1", [source_card_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn execute_update_tags(app_state: &AppState, task_id: &str, args: &Value) -> Result<(), String> {
    let card_id = args.get("cardId").and_then(Value::as_str).ok_or_else(|| "缺少 cardId".to_string())?;
    let tags = args
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 tags".to_string())?
        .iter()
        .filter_map(Value::as_str)
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    let card = get_card(&app_state.db, card_id)?.ok_or_else(|| "卡片不存在".to_string())?;
    create_record_snapshot(&app_state.db, task_id, "card", card_id, Some(&card))?;
    update_card(&app_state.db, card_id, &card.title, &card.content_md, tags)?;
    Ok(())
}

fn execute_create_relation(app_state: &AppState, task_id: &str, args: &Value) -> Result<(), String> {
    let project_id = args.get("projectId").and_then(Value::as_str).unwrap_or("");
    let from_node_id = args.get("fromNodeId").and_then(Value::as_str).ok_or_else(|| "缺少 fromNodeId".to_string())?;
    let to_node_id = args.get("toNodeId").and_then(Value::as_str).ok_or_else(|| "缺少 toNodeId".to_string())?;
    let relation_type = args.get("relationType").and_then(Value::as_str).unwrap_or("related");
    let snapshot = create_record_snapshot::<Value>(&app_state.db, task_id, "relation", &format!("new:{from_node_id}:{to_node_id}:{relation_type}"), None)?;
    let relation = upsert_relation(
        &app_state.db,
        UpsertRelationInput {
            project_id,
            from_node_id,
            to_node_id,
            relation_type,
            confidence: Some(0.8),
            origin_type: "agent",
            source_ref: Some(task_id),
            confirmed_by_user: true,
        },
    )?;
    let _ = snapshot;
    app_state
        .db
        .execute(
            "UPDATE snapshots SET entity_id = ?1 WHERE snapshot_id = ?2",
            params![relation.relation_id, snapshot.snapshot_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn execute_remove_relation(app_state: &AppState, task_id: &str, args: &Value) -> Result<(), String> {
    let relation_id = args.get("relationId").and_then(Value::as_str).ok_or_else(|| "缺少 relationId".to_string())?;
    let relation = get_relation(&app_state.db, relation_id)?.ok_or_else(|| "关系不存在".to_string())?;
    create_record_snapshot(&app_state.db, task_id, "relation", relation_id, Some(&relation))?;
    remove_relation(&app_state.db, relation_id)?;
    Ok(())
}

fn execute_export_project(app_state: &AppState, task_id: &str, project_root: &str, args: &Value) -> Result<(), String> {
    let target_dir = args.get("targetDir").and_then(Value::as_str).unwrap_or("exports");
    let target = resolve_project_relative_path(Path::new(project_root), target_dir)?;
    assert_within_project_root(Path::new(project_root), &target)?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let project_id = get_agent_task(&app_state.db, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?.project_id;
    let documents = list_documents(&app_state.db, &project_id).map_err(|error| error.to_string())?;
    let mut manifest = String::from("# KnowledgeOS 导出清单\n\n");
    for document in documents {
        manifest.push_str(&format!("- {} ({})\n", document.title.unwrap_or(document.document_id), document.parse_status));
    }
    fs::write(target.join("manifest.md"), manifest).map_err(|error| error.to_string())?;
    Ok(())
}

fn resolve_document_for_execution(
    app_state: &AppState,
    project_id: &str,
    project_root: &str,
    args: &Value,
) -> Result<Option<crate::services::import::DocumentRecord>, String> {
    if let Some(document_id) = args
        .get("documentId")
        .or_else(|| args.get("sourceDocumentId"))
        .and_then(Value::as_str)
    {
        return get_document(&app_state.db, document_id).map_err(|error| error.to_string());
    }

    let relative_path = args
        .get("sourcePath")
        .or_else(|| args.get("path"))
        .and_then(Value::as_str);
    let Some(relative_path) = relative_path else {
        return Ok(None);
    };
    let normalized_target = normalize_agent_path(relative_path);
    let project_root_path = Path::new(project_root);
    let documents = list_documents(&app_state.db, project_id).map_err(|error| error.to_string())?;
    Ok(documents.into_iter().find(|document| {
        let source_relative = make_relative_path(project_root_path, &document.source_path);
        let normalized_relative = document
            .normalized_md_path
            .as_deref()
            .map(|path| make_relative_path(project_root_path, path));
        source_relative == normalized_target || normalized_relative.as_deref() == Some(normalized_target.as_str())
    }))
}

fn load_document_content(app_state: &AppState, document_id: &str) -> Result<String, String> {
    let document = get_document(&app_state.db, document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;

    if let Some(normalized_path) = document.normalized_md_path.as_deref()
        && Path::new(normalized_path).exists()
    {
        return fs::read_to_string(normalized_path).map_err(|error| error.to_string());
    }

    if document.source_type == "md" || document.source_type == "txt" {
        return fs::read_to_string(&document.source_path).map_err(|error| error.to_string());
    }

    let blocks = list_blocks(&app_state.db, document_id).map_err(|error| error.to_string())?;
    if !blocks.is_empty() {
        let markdown = blocks
            .into_iter()
            .map(|block| block.content_md)
            .collect::<Vec<_>>()
            .join("\n\n");
        return Ok(markdown);
    }

    fs::read_to_string(&document.source_path).map_err(|error| error.to_string())
}

fn generate_markdown_content(
    app_state: &AppState,
    source_document_id: Option<&str>,
    instruction: &str,
    task_text: &str,
    context: &mut ExecutionContext,
) -> Result<String, String> {
    let adapter = build_model_adapter(&app_state.config.model_settings)?;
    let system_prompt = "你是 KnowledgeOS 的本地文件 Agent 内容生成器。你不会决定工具、路径和权限，只负责根据用户任务、可选的源文档内容和生成指令，输出可以直接写入文件的 Markdown 正文。只能返回 Markdown，不要解释，不要包裹代码块围栏，不要返回 JSON。";
    let (prompt, context_blocks, metadata_json) = if let Some(source_document_id) = source_document_id {
        let loaded = if let Some(existing) = context.loaded_documents.get(source_document_id) {
            existing
        } else {
            let document = get_document(&app_state.db, source_document_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "源文档不存在".to_string())?;
            let content_md = load_document_content(app_state, source_document_id)?;
            context.loaded_documents.insert(
                source_document_id.to_string(),
                LoadedDocumentContext {
                    document_id: source_document_id.to_string(),
                    title: document.title.unwrap_or_else(|| source_document_id.to_string()),
                    content_md,
                },
            );
            context
                .loaded_documents
                .get(source_document_id)
                .ok_or_else(|| "缓存源文档失败".to_string())?
        };

        (
            format!(
                "用户任务：{}\n生成指令：{}\n源文档标题：{}\n源文档ID：{}\n\n源文档 Markdown 内容：\n{}",
                task_text,
                instruction,
                loaded.title,
                loaded.document_id,
                truncate_for_generation(&loaded.content_md, 12000)
            ),
            vec![loaded.title.clone()],
            serde_json::json!({
                "sourceDocumentId": source_document_id,
                "instruction": instruction
            })
            .to_string(),
        )
    } else {
        (
            format!(
                "用户任务：{}\n生成指令：{}\n\n请直接生成一份完整 Markdown 内容。",
                task_text, instruction
            ),
            Vec::new(),
            serde_json::json!({
                "instruction": instruction
            })
            .to_string(),
        )
    };
    let response = adapter.complete(&ModelRequest {
        task_type: "agent.execute".to_string(),
        provider: app_state.config.model_settings.provider.clone(),
        model: app_state.config.model_settings.tool_model.clone(),
        system_prompt: system_prompt.to_string(),
        prompt,
        output_format: "text".to_string(),
        context_blocks,
        metadata_json,
        temperature: 0.2,
        max_output_tokens: 2200,
    })?;
    let output = response.output_text.trim().to_string();
    if output.is_empty() {
        Err("模型未生成可写入的 Markdown 内容".to_string())
    } else {
        Ok(output)
    }
}

fn truncate_for_generation(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        content.to_string()
    } else {
        format!(
            "{}\n\n<!-- 内容已截断，用于控制生成长度 -->",
            content.chars().take(max_chars).collect::<String>()
        )
    }
}

fn normalize_agent_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn make_relative_path(project_root: &Path, path: &str) -> String {
    PathBuf::from(path)
        .strip_prefix(project_root)
        .map(|value| normalize_agent_path(&value.to_string_lossy()))
        .unwrap_or_else(|_| normalize_agent_path(path))
}

fn upsert_generated_markdown_document(
    app_state: &AppState,
    task_id: &str,
    project_id: &str,
    target: &Path,
    content_md: &str,
) -> Result<(), String> {
    let source_path = target.to_string_lossy().into_owned();
    let now = Utc::now().to_rfc3339();
    let title = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名笔记")
        .to_string();
    let source_hash = format!("{:x}", Sha256::digest(content_md.as_bytes()));

    let existing = app_state
        .db
        .query_row(
            "SELECT document_id, imported_at FROM documents WHERE project_id = ?1 AND source_path = ?2 LIMIT 1",
            params![project_id, source_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    let document_id = existing
        .as_ref()
        .map(|item| item.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let imported_at = existing
        .as_ref()
        .map(|item| item.1.clone())
        .unwrap_or_else(|| now.clone());

    if let Some(existing_document_id) = existing.as_ref().map(|item| item.0.as_str()) {
        let existing_document = get_document(&app_state.db, existing_document_id)
            .map_err(|error| error.to_string())?;
        create_record_snapshot(&app_state.db, task_id, "document", existing_document_id, existing_document.as_ref())?;
        app_state
            .db
            .execute("DELETE FROM blocks WHERE document_id = ?1", [existing_document_id])
            .map_err(|error| error.to_string())?;
    }

    app_state
        .db
        .execute(
            "INSERT OR REPLACE INTO documents (
                document_id, project_id, source_path, source_type, source_hash, normalized_md_path,
                manifest_path, title, parse_status, imported_at, updated_at, last_error_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                document_id,
                project_id,
                source_path,
                "md",
                source_hash,
                target.to_string_lossy().into_owned(),
                Option::<String>::None,
                title,
                "ready",
                imported_at,
                now,
                Option::<String>::None
            ],
        )
        .map_err(|error| error.to_string())?;

    let block_id = format!("agent-note-{}", Uuid::new_v4());
    let heading_path_json = "[]".to_string();
    let token_count = ((content_md.chars().count() as f64) / 4.0).ceil() as i64;
    app_state
        .db
        .execute(
            "INSERT INTO blocks (
                block_id, project_id, document_id, block_type, title, heading_path, depth, order_index,
                content_md, token_count, source_anchor, parent_block_id, is_favorite, note, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                block_id,
                project_id,
                document_id,
                "note",
                target.file_stem().and_then(|value| value.to_str()),
                heading_path_json,
                0i64,
                0i64,
                content_md,
                token_count,
                Option::<String>::None,
                Option::<String>::None,
                0i64,
                Option::<String>::None,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;

    rebuild_project_search_index(&app_state.db, project_id)?;
    Ok(())
}
