use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::config::AppConfig;
use crate::services::agent::{
    AGENT_STATUS_PLANNED, AgentPlan, AgentPlanStep, AgentTaskRecord, append_task_log,
    create_agent_task, save_agent_plan,
};
use crate::services::agent::tools::{is_registered_tool, tool_registry};
use crate::services::project::get_project;
use crate::state::AppState;

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

    let plan = match generate_plan_with_model(&app_state.config, &project.name, task_text) {
        Ok(plan) => sanitize_plan(plan),
        Err(_) => build_fallback_plan(task_text),
    };

    let task = save_agent_plan(&app_state.db, &task.task_id, &plan)?;
    append_task_log(
        &app_state.db,
        &task.task_id,
        "info",
        &format!("已生成计划，共 {} 步", plan.steps.len()),
    )?;
    if task.status == AGENT_STATUS_PLANNED {
        append_task_log(&app_state.db, &task.task_id, "info", "该任务无需额外审批，可直接执行")?;
    }
    Ok((task, plan))
}

fn generate_plan_with_model(
    config: &AppConfig,
    project_name: &str,
    task_text: &str,
) -> Result<AgentPlan, String> {
    let adapter = build_model_adapter(&config.model_settings)?;
    let prompt_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("prompt-templates")
        .join("agent_planner_system.md");
    let system_prompt = fs::read_to_string(prompt_path).map_err(|error| error.to_string())?;
    let tools = tool_registry()
        .into_iter()
        .map(|tool| format!("- {}：{}", tool.name, tool.description))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "项目名称：{}\n可用工具：\n{}\n\n用户任务：{}\n\n请输出严格 JSON。",
        project_name, tools, task_text
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
        temperature: 0.2,
        max_output_tokens: 1400,
    })?;
    serde_json::from_str::<AgentPlan>(&extract_json_object(&response.output_text)?)
        .map_err(|error| error.to_string())
}

fn sanitize_plan(mut plan: AgentPlan) -> AgentPlan {
    plan.planner_version = if plan.planner_version.trim().is_empty() {
        "agent-plan.v1".to_string()
    } else {
        plan.planner_version
    };
    plan.requires_approval = true;
    plan.steps.retain(|step| is_registered_tool(&step.tool_name));
    plan
}

fn build_fallback_plan(task_text: &str) -> AgentPlan {
    let lower = task_text.to_lowercase();
    let step = if task_text.contains("导出") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "导出当前项目".to_string(),
            tool_name: "export_project".to_string(),
            reason: "用户明确要求导出项目".to_string(),
            risk_level: "low".to_string(),
            arguments_json: "{\"targetDir\":\"exports\"}".to_string(),
            target_refs: vec!["project".to_string()],
        }
    } else if task_text.contains("标签") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "更新卡片标签".to_string(),
            tool_name: "update_tags".to_string(),
            reason: "任务文本包含标签更新诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"cardId\":\"\",\"tags\":[]}".to_string(),
            target_refs: vec![],
        }
    } else if lower.contains("重命名") || lower.contains("rename") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "重命名项目内文件".to_string(),
            tool_name: "rename_file".to_string(),
            reason: "任务文本包含文件重命名诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"documentId\":\"\",\"newName\":\"\"}".to_string(),
            target_refs: vec![],
        }
    } else if task_text.contains("关系") && (task_text.contains("删除") || task_text.contains("移除")) {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "删除图谱关系".to_string(),
            tool_name: "remove_relation".to_string(),
            reason: "任务文本明确要求删除关系".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"relationId\":\"\"}".to_string(),
            target_refs: vec![],
        }
    } else if task_text.contains("关系") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "创建图谱关系".to_string(),
            tool_name: "create_relation".to_string(),
            reason: "任务文本包含关系创建诉求".to_string(),
            risk_level: "medium".to_string(),
            arguments_json: "{\"fromNodeId\":\"\",\"toNodeId\":\"\",\"relationType\":\"related\"}".to_string(),
            target_refs: vec![],
        }
    } else if task_text.contains("卡片") && task_text.contains("合并") {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "合并卡片".to_string(),
            tool_name: "merge_cards".to_string(),
            reason: "任务文本包含卡片合并诉求".to_string(),
            risk_level: "high".to_string(),
            arguments_json: "{\"sourceCardId\":\"\",\"targetCardId\":\"\"}".to_string(),
            target_refs: vec![],
        }
    } else {
        AgentPlanStep {
            step_id: "step-1".to_string(),
            title: "读取项目目录".to_string(),
            tool_name: "read_project_tree".to_string(),
            reason: "任务目标不够明确，先生成低风险读取步骤".to_string(),
            risk_level: "low".to_string(),
            arguments_json: "{\"path\":\".\"}".to_string(),
            target_refs: vec!["project".to_string()],
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

fn extract_json_object(text: &str) -> Result<String, String> {
    let start = text.find('{').ok_or_else(|| "模型未返回 JSON".to_string())?;
    let end = text.rfind('}').ok_or_else(|| "模型未返回完整 JSON".to_string())?;
    let candidate = &text[start..=end];
    let _: Value = serde_json::from_str(candidate).map_err(|error| error.to_string())?;
    Ok(candidate.to_string())
}
