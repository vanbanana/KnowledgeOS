use crate::services::normalize::NormalizedManifest;

use super::DraftBlock;

#[derive(Debug, Clone)]
struct HeadingLine {
    line_index: usize,
    depth: usize,
    title: String,
}

pub fn chunk_by_structure(markdown: &str, manifest: &NormalizedManifest) -> Vec<DraftBlock> {
    let lines: Vec<&str> = markdown.lines().collect();
    let heading_lines = collect_heading_lines(&lines);
    if heading_lines.is_empty() {
        return chunk_without_headings(markdown, manifest);
    }

    let mut blocks = Vec::new();
    let mut heading_stack: Vec<String> = Vec::new();

    for (index, heading) in heading_lines.iter().enumerate() {
        while heading_stack.len() >= heading.depth {
            heading_stack.pop();
        }
        heading_stack.push(heading.title.clone());

        let end_line = heading_lines
            .get(index + 1)
            .map(|next| next.line_index)
            .unwrap_or(lines.len());
        let content = lines[heading.line_index..end_line]
            .join("\n")
            .trim()
            .to_string();
        if content.is_empty() {
            continue;
        }

        let section_meta = manifest.sections.get(index);
        let source_anchor = section_meta
            .map(|value| value.anchor.clone())
            .or_else(|| Some(slugify_anchor(&heading.title)));
        let parent_block_key = if heading_stack.len() > 1 {
            Some(heading_stack[..heading_stack.len() - 1].join(" > "))
        } else {
            None
        };

        blocks.push(DraftBlock {
            title: Some(heading.title.clone()),
            heading_path: heading_stack.clone(),
            depth: heading.depth.saturating_sub(1) as i64,
            block_type: "section".to_string(),
            content_md: content,
            source_anchor,
            parent_lookup_key: parent_block_key,
        });
    }

    blocks
}

fn collect_heading_lines(lines: &[&str]) -> Vec<HeadingLine> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let trimmed = line.trim();
            let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
            if hashes == 0 || trimmed.chars().nth(hashes) != Some(' ') {
                return None;
            }
            Some(HeadingLine {
                line_index,
                depth: hashes,
                title: trimmed[hashes + 1..].trim().to_string(),
            })
        })
        .collect()
}

fn chunk_without_headings(markdown: &str, manifest: &NormalizedManifest) -> Vec<DraftBlock> {
    let paragraphs: Vec<String> = markdown
        .split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    if paragraphs.is_empty() {
        return Vec::new();
    }

    paragraphs
        .into_iter()
        .enumerate()
        .map(|(index, content)| DraftBlock {
            title: if index == 0 {
                Some(manifest.title.clone())
            } else {
                Some(format!("段落 {}", index + 1))
            },
            heading_path: vec![manifest.title.clone()],
            depth: 0,
            block_type: "paragraph".to_string(),
            content_md: content,
            source_anchor: Some(
                manifest
                    .sections
                    .get(index)
                    .map(|value| value.anchor.clone())
                    .unwrap_or_else(|| format!("paragraph-{}", index + 1)),
            ),
            parent_lookup_key: None,
        })
        .collect()
}

fn slugify_anchor(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
        } else if (character.is_whitespace() || character == '-' || character == '_')
            && !output.ends_with('-')
        {
            output.push('-');
        }
    }
    output.trim_matches('-').to_string()
}
