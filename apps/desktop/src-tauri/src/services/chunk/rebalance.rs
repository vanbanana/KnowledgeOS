use super::DraftBlock;

const MAX_ESTIMATED_TOKENS: usize = 320;
const MIN_ESTIMATED_TOKENS: usize = 60;

pub fn rebalance_blocks(blocks: Vec<DraftBlock>) -> Vec<DraftBlock> {
    let mut rebalanced = Vec::new();

    for block in blocks {
        if estimate_tokens(&block.content_md) > MAX_ESTIMATED_TOKENS {
            rebalanced.extend(split_large_block(&block));
        } else {
            rebalanced.push(block);
        }
    }

    merge_small_neighbors(rebalanced)
}

pub fn estimate_tokens(content: &str) -> usize {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        0
    } else {
        (trimmed.chars().count() / 4).max(1)
    }
}

fn split_large_block(block: &DraftBlock) -> Vec<DraftBlock> {
    let paragraphs: Vec<&str> = block
        .content_md
        .split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if paragraphs.len() <= 1 {
        return vec![block.clone()];
    }

    let mut output = Vec::new();
    let mut current = String::new();
    let mut chunk_index = 1;

    for paragraph in paragraphs {
        let candidate = if current.is_empty() {
            paragraph.to_string()
        } else {
            format!("{current}\n\n{paragraph}")
        };

        if estimate_tokens(&candidate) > MAX_ESTIMATED_TOKENS && !current.is_empty() {
            output.push(build_split_block(block, &current, chunk_index));
            chunk_index += 1;
            current = paragraph.to_string();
        } else {
            current = candidate;
        }
    }

    if !current.is_empty() {
        output.push(build_split_block(block, &current, chunk_index));
    }

    output
}

fn build_split_block(block: &DraftBlock, content: &str, chunk_index: usize) -> DraftBlock {
    let mut title = block.title.clone();
    if chunk_index > 1 {
        title = title.map(|value| format!("{value}（续 {chunk_index}）"));
    }

    DraftBlock {
        title,
        heading_path: block.heading_path.clone(),
        depth: block.depth,
        block_type: block.block_type.clone(),
        content_md: content.trim().to_string(),
        source_anchor: block.source_anchor.clone(),
        parent_lookup_key: block.parent_lookup_key.clone(),
    }
}

fn merge_small_neighbors(blocks: Vec<DraftBlock>) -> Vec<DraftBlock> {
    let mut output: Vec<DraftBlock> = Vec::new();

    for block in blocks {
        let should_merge = output
            .last()
            .map(|last| {
                estimate_tokens(&last.content_md) < MIN_ESTIMATED_TOKENS
                    && estimate_tokens(&block.content_md) < MIN_ESTIMATED_TOKENS
                    && last.depth == block.depth
                    && last.heading_path == block.heading_path
            })
            .unwrap_or(false);

        if should_merge {
            if let Some(last) = output.last_mut() {
                last.content_md =
                    format!("{}\n\n{}", last.content_md.trim(), block.content_md.trim());
            }
        } else {
            output.push(block);
        }
    }

    output
}
