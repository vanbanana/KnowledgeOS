use std::fs;
use std::path::{Path, PathBuf};

pub const PROJECT_DIRECTORIES: [&str; 10] = [
    "source",
    "normalized/docs",
    "normalized/manifests",
    "normalized/assets",
    "blocks",
    "cards",
    "exports",
    "snapshots",
    "logs",
    "temp",
];

pub fn ensure_directory(path: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(path)
}

pub fn slugify_project_name(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

pub fn create_project_layout(project_root: &Path) -> Result<Vec<String>, std::io::Error> {
    let mut created = Vec::new();
    ensure_directory(project_root)?;

    for directory in PROJECT_DIRECTORIES {
        let path = project_root.join(directory);
        ensure_directory(&path)?;
        created.push(path.to_string_lossy().into_owned());
    }

    Ok(created)
}

#[allow(dead_code)]
pub fn ensure_within_root(root: &Path, candidate: &Path) -> Result<PathBuf, std::io::Error> {
    let normalized_root = root.canonicalize()?;
    let normalized_candidate = candidate.canonicalize()?;
    if normalized_candidate.starts_with(&normalized_root) {
        Ok(normalized_candidate)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "路径超出 project_root 范围",
        ))
    }
}
