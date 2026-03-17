use sha2::{Digest, Sha256};

pub fn build_block_id(
    document_id: &str,
    heading_path: &[String],
    source_anchor: Option<&str>,
    content_md: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(document_id.as_bytes());
    hasher.update(b"|");
    hasher.update(heading_path.join(" > ").as_bytes());
    hasher.update(b"|");
    hasher.update(source_anchor.unwrap_or("").as_bytes());
    hasher.update(b"|");
    hasher.update(content_md.trim().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("blk_{}", &digest[..24])
}

#[cfg(test)]
mod tests {
    use super::build_block_id;

    #[test]
    fn 相同输入应生成稳定_id() {
        let heading_path = vec!["第一章".to_string(), "概览".to_string()];
        let first = build_block_id("doc-1", &heading_path, Some("section-1"), "同一段内容");
        let second = build_block_id("doc-1", &heading_path, Some("section-1"), "同一段内容");
        assert_eq!(first, second);
    }

    #[test]
    fn 内容变化应改变_id() {
        let heading_path = vec!["第一章".to_string()];
        let first = build_block_id("doc-1", &heading_path, Some("section-1"), "内容 A");
        let second = build_block_id("doc-1", &heading_path, Some("section-1"), "内容 B");
        assert_ne!(first, second);
    }
}
