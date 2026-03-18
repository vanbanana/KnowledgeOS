use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;

use crate::fs::sandbox::{assert_within_project_root, resolve_project_relative_path};
use crate::services::agent::{
    AGENT_STATUS_AWAITING_APPROVAL, AGENT_STATUS_COMPLETED, AGENT_STATUS_EXECUTING,
    AGENT_STATUS_FAILED, AgentTaskRecord, append_task_log, get_agent_task, parse_agent_plan,
    transition_agent_task_status,
};
use crate::services::block::{get_block, update_block_metadata};
use crate::services::card::{get_card, update_card};
use crate::services::graph::{UpsertRelationInput, get_relation, remove_relation, upsert_relation};
use crate::services::import::{get_document, list_documents};
use crate::services::project::get_project;
use crate::services::rollback::rollback_task;
use crate::services::snapshot::{
    create_file_snapshot, create_record_snapshot, snapshot_document,
};
use crate::state::AppState;

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

    for step in &plan.steps {
        let args: Value = serde_json::from_str(&step.arguments_json).map_err(|error| error.to_string())?;
        let result = execute_step(app_state, task_id, &project.root_path, &step.tool_name, &args);
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
    project_root: &str,
    tool_name: &str,
    args: &Value,
) -> Result<(), String> {
    match tool_name {
        "read_project_tree" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
            let target = resolve_project_relative_path(Path::new(project_root), path)?;
            let _ = fs::read_dir(target).map_err(|error| error.to_string())?;
            Ok(())
        }
        "read_document" => {
            let document_id = args.get("documentId").and_then(Value::as_str).ok_or_else(|| "缺少 documentId".to_string())?;
            let _ = get_document(&app_state.db, document_id).map_err(|error| error.to_string())?;
            Ok(())
        }
        "rename_file" => execute_rename_file(app_state, task_id, project_root, args),
        "move_file" => execute_move_file(app_state, task_id, project_root, args),
        "update_markdown" => execute_update_markdown(app_state, task_id, args),
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

fn execute_update_markdown(app_state: &AppState, task_id: &str, args: &Value) -> Result<(), String> {
    let block_id = args.get("blockId").and_then(Value::as_str).ok_or_else(|| "缺少 blockId".to_string())?;
    let content_md = args.get("contentMd").and_then(Value::as_str).ok_or_else(|| "缺少 contentMd".to_string())?;
    let block = get_block(&app_state.db, block_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "块不存在".to_string())?;
    create_record_snapshot(&app_state.db, task_id, "block", block_id, Some(&block))?;
    update_block_metadata(&app_state.db, block_id, None, None, block.title.as_deref(), Some(content_md))?;
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
