use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorHit {
    pub entity_type: String,
    pub entity_id: String,
    pub project_id: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub jump_target: String,
}

#[allow(dead_code)]
pub trait EmbeddingProvider {
    fn embed_text(&self, text: &str) -> Vec<f64>;
}

pub trait VectorIndex {
    fn query(
        &self,
        connection: &Connection,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<VectorHit>, String>;
}

#[allow(dead_code)]
pub struct MockEmbeddingProvider;

impl EmbeddingProvider for MockEmbeddingProvider {
    fn embed_text(&self, text: &str) -> Vec<f64> {
        let mut frequencies = HashMap::new();
        for token in tokenize(text) {
            *frequencies.entry(token).or_insert(0.0) += 1.0;
        }
        frequencies.into_values().collect()
    }
}

pub struct MockVectorIndex;

impl VectorIndex for MockVectorIndex {
    fn query(
        &self,
        connection: &Connection,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<VectorHit>, String> {
        let query_tokens = tokenize(query);
        if query_tokens.is_empty() {
            return Ok(Vec::new());
        }

        let mut hits = Vec::new();
        let mut statement = connection
            .prepare(
                "SELECT block_id, document_id, COALESCE(title, ''), content_md, source_anchor
                 FROM blocks
                 WHERE project_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let block_rows = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in block_rows {
            let (block_id, document_id, title, content_md, source_anchor) =
                row.map_err(|error| error.to_string())?;
            let score = overlap_score(&query_tokens, &tokenize(&format!("{title} {content_md}")));
            if score > 0.0 {
                hits.push(VectorHit {
                    entity_type: "block".to_string(),
                    entity_id: block_id,
                    project_id: project_id.to_string(),
                    title: if title.is_empty() {
                        format!("Block {document_id}")
                    } else {
                        title
                    },
                    snippet: build_snippet(&content_md),
                    score,
                    jump_target: source_anchor.unwrap_or(document_id),
                });
            }
        }

        let mut card_statement = connection
            .prepare(
                "SELECT card_id, title, content_md
                 FROM cards
                 WHERE project_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let card_rows = card_statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in card_rows {
            let (card_id, title, content_md) = row.map_err(|error| error.to_string())?;
            let score = overlap_score(&query_tokens, &tokenize(&format!("{title} {content_md}")));
            if score > 0.0 {
                hits.push(VectorHit {
                    entity_type: "card".to_string(),
                    entity_id: card_id.clone(),
                    project_id: project_id.to_string(),
                    title,
                    snippet: build_snippet(&content_md),
                    score,
                    jump_target: card_id,
                });
            }
        }

        hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

fn tokenize(text: &str) -> HashSet<String> {
    text.split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_lowercase())
        .collect()
}

fn overlap_score(query_tokens: &HashSet<String>, content_tokens: &HashSet<String>) -> f64 {
    if content_tokens.is_empty() {
        return 0.0;
    }
    let overlap = query_tokens.intersection(content_tokens).count() as f64;
    overlap / query_tokens.len().max(1) as f64
}

fn build_snippet(content: &str) -> String {
    let snippet = content.replace('\n', " ");
    snippet.chars().take(140).collect()
}
