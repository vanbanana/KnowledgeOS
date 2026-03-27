pub mod query;
pub mod rag;
pub mod suggest;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

use crate::services::card::CardRecord;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeRecord {
    pub node_id: String,
    pub project_id: String,
    pub node_type: String,
    pub label: String,
    pub source_ref: Option<String>,
    pub metadata_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelationRecord {
    pub relation_id: String,
    pub project_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub relation_type: String,
    pub confidence: Option<f64>,
    pub origin_type: String,
    pub source_ref: Option<String>,
    pub confirmed_by_user: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationSuggestionRecord {
    pub relation: GraphRelationRecord,
    pub from_node_label: String,
    pub to_node_label: String,
}

pub struct UpsertRelationInput<'a> {
    pub project_id: &'a str,
    pub from_node_id: &'a str,
    pub to_node_id: &'a str,
    pub relation_type: &'a str,
    pub confidence: Option<f64>,
    pub origin_type: &'a str,
    pub source_ref: Option<&'a str>,
    pub confirmed_by_user: bool,
}

#[derive(Debug, Deserialize)]
struct StudioPreviewPayload {
    graph: Option<StudioPreviewGraph>,
}

#[derive(Debug, Deserialize)]
struct StudioPreviewGraph {
    nodes: Vec<StudioPreviewNode>,
    links: Vec<StudioPreviewLink>,
}

#[derive(Debug, Deserialize)]
struct StudioPreviewNode {
    id: String,
    label: String,
    weight: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct StudioPreviewLink {
    source: String,
    target: String,
}

pub fn sync_card_node(
    connection: &Connection,
    card: &CardRecord,
) -> Result<GraphNodeRecord, String> {
    if let Some(existing) = get_node_by_source_ref(connection, &card.project_id, &card.card_id)? {
        let updated_at = Utc::now().to_rfc3339();
        let metadata_json = serde_json::json!({
            "cardId": card.card_id,
            "sourceBlockId": card.source_block_id,
            "sourceExplanationId": card.source_explanation_id,
            "tags": serde_json::from_str::<serde_json::Value>(&card.tags_json).unwrap_or_else(|_| serde_json::json!([]))
        })
        .to_string();
        connection
            .execute(
                "UPDATE graph_nodes
                 SET label = ?1, metadata_json = ?2, updated_at = ?3
                 WHERE node_id = ?4",
                params![card.title, metadata_json, updated_at, existing.node_id],
            )
            .map_err(|error| error.to_string())?;
        return get_node(connection, &existing.node_id)?
            .ok_or_else(|| "同步图谱节点失败".to_string());
    }

    let node_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let metadata_json = serde_json::json!({
        "cardId": card.card_id,
        "sourceBlockId": card.source_block_id,
        "sourceExplanationId": card.source_explanation_id,
        "tags": serde_json::from_str::<serde_json::Value>(&card.tags_json).unwrap_or_else(|_| serde_json::json!([]))
    })
    .to_string();
    connection
        .execute(
            "INSERT INTO graph_nodes (
                node_id, project_id, node_type, label, source_ref, metadata_json, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                node_id,
                card.project_id,
                "card",
                card.title,
                card.card_id,
                metadata_json,
                now,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
    get_node(connection, &node_id)?.ok_or_else(|| "同步图谱节点失败".to_string())
}

pub fn get_node(connection: &Connection, node_id: &str) -> Result<Option<GraphNodeRecord>, String> {
    connection
        .prepare(
            "SELECT node_id, project_id, node_type, label, source_ref, metadata_json, created_at, updated_at
             FROM graph_nodes
             WHERE node_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([node_id], map_node_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_nodes(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<GraphNodeRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT node_id, project_id, node_type, label, source_ref, metadata_json, created_at, updated_at
             FROM graph_nodes
             WHERE project_id = ?1
             ORDER BY updated_at DESC, label ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], map_node_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_relations(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<GraphRelationRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT relation_id, project_id, from_node_id, to_node_id, relation_type, confidence,
                    origin_type, source_ref, confirmed_by_user, created_at
             FROM graph_relations
             WHERE project_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], map_relation_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn ensure_graph_seeded_from_studio_preview(
    connection: &Connection,
    project_id: &str,
) -> Result<(), String> {
    let existing_nodes = list_nodes(connection, project_id)?;
    let existing_relations = list_relations(connection, project_id)?;
    if !existing_nodes.is_empty() && !existing_relations.is_empty() {
        return Ok(());
    }

    let preview_json = connection
        .prepare(
            "SELECT artifact_id, title, preview_json
             FROM studio_artifacts
             WHERE project_id = ?1
               AND status = 'completed'
               AND kind IN ('knowledge_graph_3d', 'knowledge_graph')
               AND preview_json IS NOT NULL
             ORDER BY
               CASE WHEN kind = 'knowledge_graph_3d' THEN 0 ELSE 1 END,
               updated_at DESC
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?
        .query_row([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((artifact_id, artifact_title, preview_json)) = preview_json else {
        return Ok(());
    };

    let parsed: StudioPreviewPayload =
        serde_json::from_str(&preview_json).map_err(|error| error.to_string())?;
    let Some(graph) = parsed.graph else {
        return Ok(());
    };
    if graph.nodes.is_empty() || graph.links.is_empty() {
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    let mut node_id_by_label = list_nodes(connection, project_id)?
        .into_iter()
        .map(|node| (node.label.to_lowercase(), node.node_id))
        .collect::<std::collections::HashMap<_, _>>();

    for node in graph.nodes {
        let normalized_label = node.label.trim().to_lowercase();
        if normalized_label.is_empty() {
            continue;
        }
        if node_id_by_label.contains_key(&normalized_label) {
            continue;
        }
        let node_id = Uuid::new_v4().to_string();
        let metadata_json = serde_json::json!({
            "studioArtifactId": artifact_id,
            "studioArtifactTitle": artifact_title,
            "previewNodeId": node.id,
            "weight": node.weight.unwrap_or(1)
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
                    "concept",
                    node.label.trim(),
                    metadata_json,
                    now,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        node_id_by_label.insert(normalized_label, node_id);
    }

    for link in graph.links {
        let from_node_id = node_id_by_label
            .get(&link.source.trim().to_lowercase())
            .cloned();
        let to_node_id = node_id_by_label
            .get(&link.target.trim().to_lowercase())
            .cloned();
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
                relation_type: "关联",
                confidence: Some(0.88),
                origin_type: "artifact",
                source_ref: Some(&artifact_id),
                confirmed_by_user: true,
            },
        )?;
    }

    Ok(())
}

pub fn upsert_relation(
    connection: &Connection,
    input: UpsertRelationInput<'_>,
) -> Result<GraphRelationRecord, String> {
    if let Some(existing) = get_relation_by_pair(
        connection,
        input.project_id,
        input.from_node_id,
        input.to_node_id,
        input.relation_type,
    )? {
        connection
            .execute(
                "UPDATE graph_relations
                 SET confidence = ?1, origin_type = ?2, source_ref = ?3, confirmed_by_user = ?4
                 WHERE relation_id = ?5",
                params![
                    input.confidence,
                    input.origin_type,
                    input.source_ref,
                    if input.confirmed_by_user { 1 } else { 0 },
                    existing.relation_id
                ],
            )
            .map_err(|error| error.to_string())?;
        return get_relation(connection, &existing.relation_id)?
            .ok_or_else(|| "更新关系失败".to_string());
    }

    let relation_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO graph_relations (
                relation_id, project_id, from_node_id, to_node_id, relation_type,
                confidence, origin_type, source_ref, confirmed_by_user, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                relation_id,
                input.project_id,
                input.from_node_id,
                input.to_node_id,
                input.relation_type,
                input.confidence,
                input.origin_type,
                input.source_ref,
                if input.confirmed_by_user { 1 } else { 0 },
                created_at
            ],
        )
        .map_err(|error| error.to_string())?;
    get_relation(connection, &relation_id)?.ok_or_else(|| "创建关系失败".to_string())
}

pub fn remove_relation(connection: &Connection, relation_id: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM graph_relations WHERE relation_id = ?1",
            [relation_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn confirm_relation(
    connection: &Connection,
    relation_id: &str,
) -> Result<GraphRelationRecord, String> {
    connection
        .execute(
            "UPDATE graph_relations
             SET confirmed_by_user = 1, origin_type = CASE WHEN origin_type = 'suggested' THEN 'confirmed' ELSE origin_type END
             WHERE relation_id = ?1",
            [relation_id],
        )
        .map_err(|error| error.to_string())?;
    get_relation(connection, relation_id)?.ok_or_else(|| "关系不存在".to_string())
}

pub fn get_node_by_source_ref(
    connection: &Connection,
    project_id: &str,
    source_ref: &str,
) -> Result<Option<GraphNodeRecord>, String> {
    connection
        .prepare(
            "SELECT node_id, project_id, node_type, label, source_ref, metadata_json, created_at, updated_at
             FROM graph_nodes
             WHERE project_id = ?1 AND source_ref = ?2
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?
        .query_row(params![project_id, source_ref], map_node_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn get_relation(
    connection: &Connection,
    relation_id: &str,
) -> Result<Option<GraphRelationRecord>, String> {
    connection
        .prepare(
            "SELECT relation_id, project_id, from_node_id, to_node_id, relation_type, confidence,
                    origin_type, source_ref, confirmed_by_user, created_at
             FROM graph_relations
             WHERE relation_id = ?1",
        )
        .map_err(|error| error.to_string())?
        .query_row([relation_id], map_relation_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn get_relation_by_pair(
    connection: &Connection,
    project_id: &str,
    from_node_id: &str,
    to_node_id: &str,
    relation_type: &str,
) -> Result<Option<GraphRelationRecord>, String> {
    connection
        .prepare(
            "SELECT relation_id, project_id, from_node_id, to_node_id, relation_type, confidence,
                    origin_type, source_ref, confirmed_by_user, created_at
             FROM graph_relations
             WHERE project_id = ?1 AND from_node_id = ?2 AND to_node_id = ?3 AND relation_type = ?4
             LIMIT 1",
        )
        .map_err(|error| error.to_string())?
        .query_row(
            params![project_id, from_node_id, to_node_id, relation_type],
            map_relation_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn map_node_row(row: &rusqlite::Row<'_>) -> Result<GraphNodeRecord, rusqlite::Error> {
    Ok(GraphNodeRecord {
        node_id: row.get(0)?,
        project_id: row.get(1)?,
        node_type: row.get(2)?,
        label: row.get(3)?,
        source_ref: row.get(4)?,
        metadata_json: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_relation_row(row: &rusqlite::Row<'_>) -> Result<GraphRelationRecord, rusqlite::Error> {
    Ok(GraphRelationRecord {
        relation_id: row.get(0)?,
        project_id: row.get(1)?,
        from_node_id: row.get(2)?,
        to_node_id: row.get(3)?,
        relation_type: row.get(4)?,
        confidence: row.get(5)?,
        origin_type: row.get(6)?,
        source_ref: row.get(7)?,
        confirmed_by_user: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
    })
}
