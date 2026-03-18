use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub allows_write: bool,
}

pub fn tool_registry() -> Vec<AgentToolDefinition> {
    vec![
        build_tool("read_project_tree", "读取项目目录树", false),
        build_tool("read_document", "读取文档或块内容", false),
        build_tool("rename_file", "重命名项目内文件", true),
        build_tool("move_file", "移动项目内文件", true),
        build_tool("delete_file", "删除项目内文件", true),
        build_tool("update_markdown", "更新文档块或 markdown 内容", true),
        build_tool("merge_cards", "合并两张卡片", true),
        build_tool("update_tags", "更新卡片标签", true),
        build_tool("create_relation", "创建图谱关系", true),
        build_tool("remove_relation", "删除图谱关系", true),
        build_tool("export_project", "导出当前项目", false),
    ]
}

pub fn is_registered_tool(name: &str) -> bool {
    tool_registry().iter().any(|tool| tool.name == name)
}

fn build_tool(name: &str, description: &str, allows_write: bool) -> AgentToolDefinition {
    AgentToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        allows_write,
    }
}
