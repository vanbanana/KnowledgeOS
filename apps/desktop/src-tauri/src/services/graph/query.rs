use serde::Serialize;

use crate::services::graph::{GraphNodeRecord, GraphRelationRecord, list_nodes, list_relations};

#[derive(Debug, Clone)]
pub struct SubgraphFilters {
    pub project_id: String,
    pub node_types: Vec<String>,
    pub query_text: Option<String>,
    pub relation_confirmed_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubgraphRecord {
    pub nodes: Vec<GraphNodeRecord>,
    pub relations: Vec<GraphRelationRecord>,
}

pub fn get_subgraph(
    connection: &rusqlite::Connection,
    filters: &SubgraphFilters,
) -> Result<SubgraphRecord, String> {
    let mut nodes = list_nodes(connection, &filters.project_id)?;
    if !filters.node_types.is_empty() {
        nodes.retain(|node| {
            filters
                .node_types
                .iter()
                .any(|item| item == &node.node_type)
        });
    }
    if let Some(query_text) = &filters.query_text {
        let normalized = query_text.to_lowercase();
        nodes.retain(|node| node.label.to_lowercase().contains(&normalized));
    }

    let node_ids = nodes
        .iter()
        .map(|node| node.node_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut relations = list_relations(connection, &filters.project_id)?;
    relations.retain(|relation| {
        node_ids.contains(&relation.from_node_id)
            && node_ids.contains(&relation.to_node_id)
            && (!filters.relation_confirmed_only || relation.confirmed_by_user)
    });

    Ok(SubgraphRecord { nodes, relations })
}
