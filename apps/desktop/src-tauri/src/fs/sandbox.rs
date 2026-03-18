use std::path::{Component, Path, PathBuf};

pub fn resolve_project_relative_path(
    project_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let candidate = Path::new(relative_path);
    if candidate.is_absolute() {
        return Err("不允许使用绝对路径".to_string());
    }

    let mut cleaned = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => cleaned.push(segment),
            Component::CurDir => {}
            Component::ParentDir => return Err("路径不能包含 ..".to_string()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("路径超出 project_root 范围".to_string());
            }
        }
    }

    if cleaned.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }

    Ok(project_root.join(cleaned))
}

pub fn assert_within_project_root(project_root: &Path, target_path: &Path) -> Result<(), String> {
    let root = project_root
        .canonicalize()
        .map_err(|error| format!("解析 project_root 失败: {error}"))?;
    let normalized = normalize_path_without_fs(target_path);
    if normalized.starts_with(&root) {
        Ok(())
    } else {
        Err("路径超出 project_root 范围".to_string())
    }
}

pub fn normalize_path_without_fs(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                normalized.pop();
            }
        }
    }
    normalized
}
