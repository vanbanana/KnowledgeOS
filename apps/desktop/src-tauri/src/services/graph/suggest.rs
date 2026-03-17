use rusqlite::{Connection, OptionalExtension, params};

use crate::services::explain::list_block_explanations;
use crate::services::graph::{
    RelationSuggestionRecord, UpsertRelationInput, confirm_relation, get_node,
    get_node_by_source_ref, upsert_relation,
};

pub fn suggest_relations_for_card(
    connection: &Connection,
    card_id: &str,
) -> Result<Vec<RelationSuggestionRecord>, String> {
    let card = connection
        .prepare(
            "SELECT card_id, project_id, source_block_id, source_explanation_id
             FROM cards
             WHERE card_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([card_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "卡片不存在".to_string())?;

    let source_block_id = card
        .2
        .ok_or_else(|| "当前卡片没有来源 block，暂时无法生成关系建议".to_string())?;
    let explanations = list_block_explanations(connection, &source_block_id)?;
    let latest = explanations
        .first()
        .ok_or_else(|| "当前 block 还没有 explanation".to_string())?;
    let related_candidates: Vec<serde_json::Value> =
        serde_json::from_str(&latest.related_candidates_json).map_err(|error| error.to_string())?;
    let from_node = get_node_by_source_ref(connection, &card.1, &card.0)?
        .ok_or_else(|| "当前卡片还未同步图谱节点".to_string())?;

    let mut suggestions = Vec::new();
    for candidate in related_candidates {
        let label = candidate
            .get("label")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let relation_hint = candidate
            .get("relationHint")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("related");
        let confidence = candidate
            .get("confidence")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.5);
        if label.is_empty() {
            continue;
        }

        let target = connection
            .prepare(
                "SELECT node_id
                 FROM graph_nodes
                 WHERE project_id = ?1 AND lower(label) = lower(?2)
                 LIMIT 1",
            )
            .map_err(|error| error.to_string())?
            .query_row(params![card.1, label], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(target_node_id) = target else {
            continue;
        };
        if target_node_id == from_node.node_id {
            continue;
        }

        let relation = upsert_relation(
            connection,
            UpsertRelationInput {
                project_id: &card.1,
                from_node_id: &from_node.node_id,
                to_node_id: &target_node_id,
                relation_type: relation_hint,
                confidence: Some(confidence),
                origin_type: "suggested",
                source_ref: Some(&latest.explanation_id),
                confirmed_by_user: false,
            },
        )?;
        let to_node =
            get_node(connection, &target_node_id)?.ok_or_else(|| "目标节点不存在".to_string())?;
        suggestions.push(RelationSuggestionRecord {
            relation,
            from_node_label: from_node.label.clone(),
            to_node_label: to_node.label,
        });
    }

    Ok(suggestions)
}

#[allow(dead_code)]
pub fn confirm_suggested_relation(
    connection: &Connection,
    relation_id: &str,
) -> Result<crate::services::graph::GraphRelationRecord, String> {
    confirm_relation(connection, relation_id)
}
