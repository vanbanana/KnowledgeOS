use serde_json::Value;

use crate::services::agent::{
    AgentPreview, AgentPreviewItem, AgentTaskRecord, append_task_log, get_agent_task, parse_agent_plan,
    save_agent_preview,
};
use crate::services::block::get_block;
use crate::services::card::get_card;
use crate::services::graph::{get_node, list_relations};
use crate::services::import::get_document;
use crate::state::AppState;

pub fn generate_preview(
    app_state: &AppState,
    task_id: &str,
) -> Result<(AgentTaskRecord, AgentPreview), String> {
    let task = get_agent_task(&app_state.db, task_id)?.ok_or_else(|| "Agent 任务不存在".to_string())?;
    let plan = parse_agent_plan(&task)?;
    let mut items = Vec::new();
    let mut impact_summary = Vec::new();
    let mut risks = Vec::new();

    for step in &plan.steps {
        let args: Value = serde_json::from_str(&step.arguments_json).unwrap_or(Value::Null);
        let item = build_preview_item(app_state, step, &args)?;
        impact_summary.push(format!("{}：{}", step.title, item.label));
        if step.risk_level != "low" {
            risks.push(format!("{} 步骤风险为 {}", step.title, step.risk_level));
        }
        items.push(item);
    }

    let preview = AgentPreview {
        summary: format!("该计划共 {} 步，将影响 {} 个对象。", plan.steps.len(), items.len()),
        impact_summary,
        risks,
        items,
    };
    let task = save_agent_preview(&app_state.db, task_id, &preview)?;
    append_task_log(&app_state.db, task_id, "info", "已生成 dry-run 预览")?;
    Ok((task, preview))
}

fn build_preview_item(
    app_state: &AppState,
    step: &crate::services::agent::AgentPlanStep,
    args: &Value,
) -> Result<AgentPreviewItem, String> {
    let mut label = step.title.clone();
    let mut target_ref = step.target_refs.first().cloned();
    let mut before_summary = None;
    let mut after_summary = None;

    match step.tool_name.as_str() {
        "read_project_tree" => {
            label = "将读取项目目录结构".to_string();
        }
        "read_document" => {
            if let Some(document_id) = args.get("documentId").and_then(Value::as_str)
                && let Some(document) = get_document(&app_state.db, document_id).map_err(|error| error.to_string())?
            {
                label = document.title.unwrap_or(document.document_id.clone());
                target_ref = Some(format!("document:{document_id}"));
                before_summary = Some(document.source_path);
            }
        }
        "rename_file" | "move_file" | "delete_file" => {
            if let Some(document_id) = args.get("documentId").and_then(Value::as_str)
                && let Some(document) = get_document(&app_state.db, document_id).map_err(|error| error.to_string())?
            {
                label = document.title.unwrap_or(document.document_id.clone());
                target_ref = Some(format!("document:{document_id}"));
                before_summary = Some(document.source_path.clone());
                after_summary = if step.tool_name == "delete_file" {
                    Some("将删除该文件及其索引记录".to_string())
                } else {
                    args
                        .get("newName")
                        .and_then(Value::as_str)
                        .map(|value| format!("将改为 {value}"))
                        .or_else(|| args.get("targetPath").and_then(Value::as_str).map(|value| value.to_string()))
                };
            }
        }
        "update_markdown" => {
            if let Some(block_id) = args.get("blockId").and_then(Value::as_str)
                && let Some(block) = get_block(&app_state.db, block_id).map_err(|error| error.to_string())?
            {
                label = block.title.unwrap_or_else(|| format!("块 {}", block.order_index + 1));
                target_ref = Some(format!("block:{block_id}"));
                before_summary = Some(truncate_text(&block.content_md));
                after_summary = args
                    .get("contentMd")
                    .and_then(Value::as_str)
                    .map(truncate_text);
            } else {
                label = args
                    .get("path")
                    .and_then(Value::as_str)
                    .map(|value| format!("将写入 {value}"))
                    .unwrap_or_else(|| "将写入新的 Markdown 文档".to_string());
                target_ref = args
                    .get("sourceDocumentId")
                    .and_then(Value::as_str)
                    .map(|value| format!("document:{value}"));
                after_summary = if args.get("contentMode").and_then(Value::as_str) == Some("generate") {
                    args.get("instruction")
                        .and_then(Value::as_str)
                        .map(|value| format!("模型将按该指令生成内容：{}", truncate_text(value)))
                } else {
                    args.get("contentMd")
                        .or_else(|| args.get("content"))
                        .and_then(Value::as_str)
                        .map(truncate_text)
                };
            }
        }
        "merge_cards" => {
            let source_card_id = args.get("sourceCardId").and_then(Value::as_str).unwrap_or("");
            let target_card_id = args.get("targetCardId").and_then(Value::as_str).unwrap_or("");
            let source_card = get_card(&app_state.db, source_card_id)?;
            let target_card = get_card(&app_state.db, target_card_id)?;
            label = format!(
                "{} -> {}",
                source_card.as_ref().map(|item| item.title.as_str()).unwrap_or("源卡片"),
                target_card.as_ref().map(|item| item.title.as_str()).unwrap_or("目标卡片")
            );
            target_ref = Some(format!("card:{target_card_id}"));
        }
        "update_tags" => {
            if let Some(card_id) = args.get("cardId").and_then(Value::as_str)
                && let Some(card) = get_card(&app_state.db, card_id)?
            {
                label = card.title;
                target_ref = Some(format!("card:{card_id}"));
                before_summary = Some(card.tags_json);
                after_summary = Some(args.get("tags").cloned().unwrap_or(Value::Array(vec![])).to_string());
            }
        }
        "create_relation" => {
            let from_node_id = args.get("fromNodeId").and_then(Value::as_str).unwrap_or("");
            let to_node_id = args.get("toNodeId").and_then(Value::as_str).unwrap_or("");
            let from = get_node(&app_state.db, from_node_id)?;
            let to = get_node(&app_state.db, to_node_id)?;
            label = format!(
                "{} -> {}",
                from.as_ref().map(|item| item.label.as_str()).unwrap_or("起点"),
                to.as_ref().map(|item| item.label.as_str()).unwrap_or("终点")
            );
        }
        "remove_relation" => {
            if let Some(relation_id) = args.get("relationId").and_then(Value::as_str) {
                let relation = list_relations(&app_state.db, &get_project_id_from_task(app_state, step)?)?
                    .into_iter()
                    .find(|item| item.relation_id == relation_id);
                if let Some(relation) = relation {
                    label = format!("{} ({})", relation.relation_type, relation.relation_id);
                    target_ref = Some(format!("relation:{relation_id}"));
                }
            }
        }
        "export_project" => {
            label = "导出当前项目".to_string();
            after_summary = args
                .get("targetDir")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
        }
        _ => {}
    }

    Ok(AgentPreviewItem {
        item_id: step.step_id.clone(),
        kind: step.tool_name.clone(),
        label,
        target_ref,
        risk_level: step.risk_level.clone(),
        before_summary,
        after_summary,
    })
}

fn get_project_id_from_task(
    app_state: &AppState,
    step: &crate::services::agent::AgentPlanStep,
) -> Result<String, String> {
    step.target_refs
        .iter()
        .find_map(|item| item.strip_prefix("project:").map(|value| value.to_string()))
        .or_else(|| {
            app_state
                .db
                .query_row("SELECT project_id FROM projects LIMIT 1", [], |row| row.get(0))
                .ok()
        })
        .ok_or_else(|| "无法解析项目上下文".to_string())
}

fn truncate_text(text: &str) -> String {
    if text.chars().count() <= 120 {
        text.to_string()
    } else {
        format!("{}...", text.chars().take(120).collect::<String>())
    }
}
