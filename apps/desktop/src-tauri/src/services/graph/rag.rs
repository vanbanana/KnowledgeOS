use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::Connection;
use serde::Serialize;

use crate::ai::model_adapter::{ModelRequest, build_model_adapter};
use crate::config::ModelSettings;
use crate::services::block::{BlockRecord, get_block};
use crate::services::card::{CardRecord, list_cards};
use crate::services::graph::{GraphNodeRecord, GraphRelationRecord, list_nodes, list_relations};
use crate::services::search::hybrid_search_project;

#[derive(Debug, Clone)]
pub struct GraphRagTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRagEvidenceRecord {
    pub evidence_type: String,
    pub node_id: Option<String>,
    pub card_id: Option<String>,
    pub block_id: Option<String>,
    pub title: String,
    pub snippet: String,
    pub source_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRagQueryRecord {
    pub answer: String,
    pub model: String,
    pub provider: String,
    pub related_nodes: Vec<GraphNodeRecord>,
    pub related_relations: Vec<GraphRelationRecord>,
    pub evidence: Vec<GraphRagEvidenceRecord>,
}

#[derive(Debug, Clone)]
pub struct GraphRagContext {
    pub project_id: String,
    pub query: String,
    pub focus_node_label: Option<String>,
    pub history: Vec<GraphRagTurn>,
    pub related_nodes: Vec<GraphNodeRecord>,
    pub related_relations: Vec<GraphRelationRecord>,
    pub evidence: Vec<GraphRagEvidenceRecord>,
}

pub fn gather_graph_rag_context(
    connection: &Connection,
    project_id: &str,
    query: &str,
    focus_node_id: Option<&str>,
    history: &[GraphRagTurn],
) -> Result<GraphRagContext, String> {
    let nodes = list_nodes(connection, project_id)?;
    let relations = list_relations(connection, project_id)?;
    let cards = list_cards(connection, project_id)?;
    let cards_by_id = cards
        .iter()
        .map(|card| (card.card_id.clone(), card.clone()))
        .collect::<HashMap<_, _>>();

    let query_tokens = build_query_tokens(query);
    let normalized_query = query.trim().to_lowercase();
    let mut scored_node_ids = HashMap::<String, f64>::new();

    if let Some(node_id) = focus_node_id.filter(|value| !value.trim().is_empty()) {
        scored_node_ids.insert(node_id.to_string(), 120.0);
    }

    for (index, result) in hybrid_search_project(connection, project_id, query)?
        .into_iter()
        .take(8)
        .enumerate()
    {
        let score = 32.0 - index as f64 * 3.0;
        match result.entity_type.as_str() {
            "card" => {
                if let Some(node) = nodes
                    .iter()
                    .find(|item| item.source_ref.as_deref() == Some(result.entity_id.as_str()))
                {
                    *scored_node_ids.entry(node.node_id.clone()).or_insert(0.0) += score;
                }
            }
            "block" => {
                for card in cards.iter().filter(|item| {
                    item.source_block_id.as_deref() == Some(result.entity_id.as_str())
                }) {
                    if let Some(node) = nodes
                        .iter()
                        .find(|item| item.source_ref.as_deref() == Some(card.card_id.as_str()))
                    {
                        *scored_node_ids.entry(node.node_id.clone()).or_insert(0.0) += score - 4.0;
                    }
                }
            }
            _ => {}
        }
    }

    for node in &nodes {
        let label = node.label.to_lowercase();
        let metadata = node.metadata_json.to_lowercase();
        if !normalized_query.is_empty() && label.contains(&normalized_query) {
            *scored_node_ids.entry(node.node_id.clone()).or_insert(0.0) += 20.0;
        }
        for token in &query_tokens {
            if label.contains(token) {
                *scored_node_ids.entry(node.node_id.clone()).or_insert(0.0) += 6.0;
            } else if metadata.contains(token) {
                *scored_node_ids.entry(node.node_id.clone()).or_insert(0.0) += 2.0;
            }
        }
    }

    let degree_by_node = build_degree_map(&relations);
    let mut seed_ids = scored_node_ids.into_iter().collect::<Vec<_>>();
    seed_ids.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut frontier = VecDeque::<(String, usize)>::new();
    let mut selected_ids = HashSet::<String>::new();
    for (node_id, _) in seed_ids.iter().take(4) {
        selected_ids.insert(node_id.clone());
        frontier.push_back((node_id.clone(), 0));
    }

    if selected_ids.is_empty() {
        let mut fallback_nodes = nodes
            .iter()
            .map(|node| {
                (
                    node.node_id.clone(),
                    degree_by_node.get(&node.node_id).copied().unwrap_or(0),
                )
            })
            .collect::<Vec<_>>();
        fallback_nodes.sort_by(|left, right| right.1.cmp(&left.1));
        for (node_id, _) in fallback_nodes.into_iter().take(6) {
            selected_ids.insert(node_id.clone());
            frontier.push_back((node_id, 0));
        }
    }

    let adjacency = build_adjacency_map(&relations);
    while let Some((node_id, depth)) = frontier.pop_front() {
        if selected_ids.len() >= 12 || depth >= 2 {
            continue;
        }
        let Some(neighbors) = adjacency.get(&node_id) else {
            continue;
        };
        let mut ranked_neighbors = neighbors
            .iter()
            .filter_map(|relation| {
                let neighbor_id = if relation.from_node_id == node_id {
                    relation.to_node_id.clone()
                } else {
                    relation.from_node_id.clone()
                };
                let degree = degree_by_node.get(&neighbor_id).copied().unwrap_or(0) as f64;
                let confirmed_bonus = if relation.confirmed_by_user { 6.0 } else { 2.0 };
                let confidence_bonus = relation.confidence.unwrap_or(0.0);
                Some((
                    neighbor_id,
                    confirmed_bonus + confidence_bonus + degree * 0.4,
                ))
            })
            .collect::<Vec<_>>();
        ranked_neighbors.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (neighbor_id, _) in ranked_neighbors.into_iter().take(4) {
            if selected_ids.insert(neighbor_id.clone()) {
                frontier.push_back((neighbor_id, depth + 1));
            }
            if selected_ids.len() >= 12 {
                break;
            }
        }
    }

    let mut related_nodes = nodes
        .into_iter()
        .filter(|node| selected_ids.contains(&node.node_id))
        .collect::<Vec<_>>();
    related_nodes.sort_by(|left, right| {
        let left_degree = degree_by_node.get(&left.node_id).copied().unwrap_or(0);
        let right_degree = degree_by_node.get(&right.node_id).copied().unwrap_or(0);
        right_degree
            .cmp(&left_degree)
            .then_with(|| left.label.cmp(&right.label))
    });

    let focus_node_label = focus_node_id
        .and_then(|node_id| related_nodes.iter().find(|node| node.node_id == node_id))
        .map(|node| node.label.clone())
        .or_else(|| related_nodes.first().map(|node| node.label.clone()));

    let related_node_ids = related_nodes
        .iter()
        .map(|node| node.node_id.clone())
        .collect::<HashSet<_>>();
    let mut related_relations = relations
        .into_iter()
        .filter(|relation| {
            related_node_ids.contains(&relation.from_node_id)
                && related_node_ids.contains(&relation.to_node_id)
        })
        .collect::<Vec<_>>();
    related_relations.sort_by(|left, right| {
        right
            .confirmed_by_user
            .cmp(&left.confirmed_by_user)
            .then_with(|| {
                right
                    .confidence
                    .unwrap_or(0.0)
                    .partial_cmp(&left.confidence.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let evidence = build_evidence(connection, &related_nodes, &cards_by_id)?;

    Ok(GraphRagContext {
        project_id: project_id.to_string(),
        query: query.trim().to_string(),
        focus_node_label,
        history: history.to_vec(),
        related_nodes,
        related_relations,
        evidence,
    })
}

pub fn complete_graph_rag_query(
    model_settings: &ModelSettings,
    context: GraphRagContext,
) -> Result<GraphRagQueryRecord, String> {
    if context.related_nodes.is_empty() {
        return Ok(GraphRagQueryRecord {
            answer: "当前项目图谱里还没有足够的节点和关系，暂时无法做 GraphRAG 问答。先生成卡片或补全关系后再试。".to_string(),
            model: "knowledgeos-local".to_string(),
            provider: "local".to_string(),
            related_nodes: Vec::new(),
            related_relations: Vec::new(),
            evidence: Vec::new(),
        });
    }

    let adapter = build_model_adapter(model_settings)?;
    let response = adapter.complete(&ModelRequest {
        task_type: "graph.ragQuery".to_string(),
        provider: model_settings.provider.clone(),
        model: model_settings.tool_model.clone(),
        system_prompt: build_graph_rag_system_prompt(),
        prompt: build_graph_rag_prompt(&context),
        output_format: "text".to_string(),
        context_blocks: context
            .evidence
            .iter()
            .map(|item| format!("{}：{}", item.title, item.snippet))
            .collect(),
        metadata_json: serde_json::json!({
            "projectId": context.project_id,
            "focusNodeLabel": context.focus_node_label,
            "relatedNodeCount": context.related_nodes.len(),
            "relatedRelationCount": context.related_relations.len()
        })
        .to_string(),
        temperature: 0.25,
        max_output_tokens: 1400,
    })?;

    Ok(GraphRagQueryRecord {
        answer: response.output_text.trim().to_string(),
        model: response.model,
        provider: response.provider,
        related_nodes: context.related_nodes,
        related_relations: context.related_relations,
        evidence: context.evidence,
    })
}

fn build_query_tokens(query: &str) -> Vec<String> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut tokens = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.trim().is_empty())
        .map(|token| token.trim().to_string())
        .collect::<Vec<_>>();

    if !tokens.iter().any(|token| token == &normalized) {
        tokens.push(normalized);
    }

    tokens
}

fn build_degree_map(relations: &[GraphRelationRecord]) -> HashMap<String, usize> {
    let mut degree_by_node = HashMap::<String, usize>::new();
    for relation in relations {
        *degree_by_node
            .entry(relation.from_node_id.clone())
            .or_insert(0) += 1;
        *degree_by_node
            .entry(relation.to_node_id.clone())
            .or_insert(0) += 1;
    }
    degree_by_node
}

fn build_adjacency_map(
    relations: &[GraphRelationRecord],
) -> HashMap<String, Vec<GraphRelationRecord>> {
    let mut adjacency = HashMap::<String, Vec<GraphRelationRecord>>::new();
    for relation in relations {
        adjacency
            .entry(relation.from_node_id.clone())
            .or_default()
            .push(relation.clone());
        adjacency
            .entry(relation.to_node_id.clone())
            .or_default()
            .push(relation.clone());
    }
    adjacency
}

fn build_evidence(
    connection: &Connection,
    nodes: &[GraphNodeRecord],
    cards_by_id: &HashMap<String, CardRecord>,
) -> Result<Vec<GraphRagEvidenceRecord>, String> {
    let mut evidence = Vec::<GraphRagEvidenceRecord>::new();
    let mut block_cache = HashMap::<String, BlockRecord>::new();

    for node in nodes {
        if evidence.len() >= 8 {
            break;
        }
        let Some(card_id) = node.source_ref.as_deref() else {
            evidence.push(GraphRagEvidenceRecord {
                evidence_type: "node".to_string(),
                node_id: Some(node.node_id.clone()),
                card_id: None,
                block_id: None,
                title: node.label.clone(),
                snippet: truncate_text(&node.metadata_json, 180),
                source_label: "图谱节点".to_string(),
            });
            continue;
        };

        let Some(card) = cards_by_id.get(card_id) else {
            continue;
        };
        evidence.push(GraphRagEvidenceRecord {
            evidence_type: "card".to_string(),
            node_id: Some(node.node_id.clone()),
            card_id: Some(card.card_id.clone()),
            block_id: card.source_block_id.clone(),
            title: card.title.clone(),
            snippet: truncate_text(&card.content_md, 220),
            source_label: "知识卡片".to_string(),
        });

        if evidence.len() >= 8 {
            break;
        }

        let Some(block_id) = card.source_block_id.as_deref() else {
            continue;
        };
        if !block_cache.contains_key(block_id) {
            if let Some(block) =
                get_block(connection, block_id).map_err(|error| error.to_string())?
            {
                block_cache.insert(block_id.to_string(), block);
            }
        }
        if let Some(block) = block_cache.get(block_id) {
            evidence.push(GraphRagEvidenceRecord {
                evidence_type: "block".to_string(),
                node_id: Some(node.node_id.clone()),
                card_id: Some(card.card_id.clone()),
                block_id: Some(block.block_id.clone()),
                title: block.title.clone().unwrap_or_else(|| node.label.clone()),
                snippet: truncate_text(&block.content_md, 220),
                source_label: "来源知识块".to_string(),
            });
        }
    }

    Ok(evidence)
}

fn build_graph_rag_system_prompt() -> String {
    [
        "你是 KnowledgeOS 的 GraphRAG 知识图谱助手。",
        "你负责结合图谱节点、关系和证据摘录，回答用户关于项目知识库的问题。",
        "必须遵守以下规则：",
        "1. 优先根据给定图谱关系和证据回答，不要编造不存在的概念链路。",
        "2. 如果证据不足，要明确指出缺口，而不是强行下结论。",
        "3. 回答要适合 PPT/知识图谱阅读场景，先讲主线，再讲关联知识。",
        "4. 当问题涉及关系梳理时，要明确说明谁依赖谁、谁属于谁、谁解释谁。",
        "5. 输出使用简洁自然的中文 Markdown，不要输出 JSON。",
    ]
    .join("\n")
}

fn build_graph_rag_prompt(context: &GraphRagContext) -> String {
    let history_text = if context.history.is_empty() {
        "无".to_string()
    } else {
        context
            .history
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(|item| format!("{}：{}", item.role, item.content))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let node_lines = context
        .related_nodes
        .iter()
        .take(12)
        .map(|node| format!("- {}（类型：{}）", node.label, node.node_type))
        .collect::<Vec<_>>()
        .join("\n");
    let node_label_by_id = context
        .related_nodes
        .iter()
        .map(|node| (node.node_id.clone(), node.label.clone()))
        .collect::<HashMap<_, _>>();
    let relation_lines = context
        .related_relations
        .iter()
        .take(20)
        .map(|relation| {
            let from_label = node_label_by_id
                .get(&relation.from_node_id)
                .cloned()
                .unwrap_or_else(|| relation.from_node_id.clone());
            let to_label = node_label_by_id
                .get(&relation.to_node_id)
                .cloned()
                .unwrap_or_else(|| relation.to_node_id.clone());
            format!(
                "- {} --{}--> {}{}",
                from_label,
                relation.relation_type,
                to_label,
                if relation.confirmed_by_user {
                    "（已确认）"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let evidence_lines = context
        .evidence
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "{}. [{}] {}：{}",
                index + 1,
                item.source_label,
                item.title,
                item.snippet
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "用户问题：{}\n焦点节点：{}\n最近对话：\n{}\n\n图谱候选节点：\n{}\n\n图谱候选关系：\n{}\n\n证据摘录：\n{}\n\n请给出最终回答，并包含以下结构：\n1. 用 1 段话直接回答用户问题。\n2. 用“关系主线”小节梳理关键概念之间的链路。\n3. 用“继续追问”小节列出 3 个可继续探索的问题。\n4. 如果证据不充分，用“证据缺口”小节说明。",
        context.query,
        context
            .focus_node_label
            .clone()
            .unwrap_or_else(|| "未指定".to_string()),
        history_text,
        node_lines,
        relation_lines,
        evidence_lines
    )
}

fn truncate_text(input: &str, max_chars: usize) -> String {
    let normalized = input
        .replace('\n', " ")
        .replace('\r', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = normalized.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}
