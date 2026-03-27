use std::path::{Path, PathBuf};
use std::{env, fs, io};

use serde::{Deserialize, Serialize};

use crate::fs::ensure_directory;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub app_name: String,
    pub workspace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub database_path: PathBuf,
    pub migrations_dir: PathBuf,
    pub prompt_templates_dir: PathBuf,
    pub parser_worker_path: PathBuf,
    pub model_settings: ModelSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    pub provider: String,
    pub api_base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub tool_model: String,
}

impl AppConfig {
    pub fn load() -> Result<Self, std::io::Error> {
        let runtime_root = resolve_runtime_root()?;
        let workspace_root = resolve_workspace_root(&runtime_root);
        let data_mode = resolve_data_directory_mode();
        let base_dir = resolve_base_directory(data_mode, &workspace_root, &runtime_root)?;
        let legacy_base_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".knowledgeos");
        let data_dir = base_dir.join("data");
        let log_dir = base_dir.join("logs");
        let projects_dir = data_dir.join("projects");
        let database_path = data_dir.join("app.db");
        let migrations_dir = resolve_migrations_dir(&workspace_root, &runtime_root)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "未找到 migrations 目录"))?;
        let prompt_templates_dir = resolve_prompt_templates_dir(&workspace_root, &runtime_root)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "未找到 prompt-templates 目录")
            })?;
        let parser_worker_path = resolve_parser_worker_path(&workspace_root, &runtime_root)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "未找到 parser worker 入口文件")
            })?;
        let model_settings_path = base_dir.join("model_settings.json");
        let fallback_settings_paths = vec![
            workspace_root
                .join(".knowledgeos")
                .join("model_settings.json"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join(".knowledgeos")
                .join("model_settings.json"),
        ];

        if data_mode == DataDirectoryMode::Workspace {
            migrate_legacy_data_dir(&legacy_base_dir, &base_dir)?;
        }
        ensure_directory(&base_dir)?;
        ensure_directory(&data_dir)?;
        ensure_directory(&log_dir)?;
        ensure_directory(&projects_dir)?;
        let model_settings = load_model_settings(&model_settings_path, &fallback_settings_paths)?;

        Ok(Self {
            app_name: "KnowFlow".to_string(),
            workspace_root,
            runtime_root,
            data_dir,
            log_dir,
            projects_dir,
            database_path,
            migrations_dir,
            prompt_templates_dir,
            parser_worker_path,
            model_settings,
        })
    }
}

fn load_model_settings(
    path: &PathBuf,
    fallback_paths: &[PathBuf],
) -> Result<ModelSettings, io::Error> {
    if let Some(api_key) = read_env_first(&["KNOWFLOW_MODEL_API_KEY", "KNOWLEDGEOS_MODEL_API_KEY"])
    {
        return Ok(ModelSettings {
            provider: read_env_first(&["KNOWFLOW_MODEL_PROVIDER", "KNOWLEDGEOS_MODEL_PROVIDER"])
                .unwrap_or_else(|| "deepseek".to_string()),
            api_base_url: read_env_first(&[
                "KNOWFLOW_MODEL_API_BASE_URL",
                "KNOWLEDGEOS_MODEL_API_BASE_URL",
            ])
            .unwrap_or_else(|| "https://api.deepseek.com/chat/completions".to_string()),
            api_key,
            default_model: read_env_first(&[
                "KNOWFLOW_MODEL_DEFAULT_MODEL",
                "KNOWLEDGEOS_MODEL_DEFAULT_MODEL",
            ])
            .unwrap_or_else(|| "deepseek-chat".to_string()),
            tool_model: read_env_first(&[
                "KNOWFLOW_MODEL_TOOL_MODEL",
                "KNOWLEDGEOS_MODEL_TOOL_MODEL",
            ])
            .unwrap_or_else(|| "deepseek-chat".to_string()),
        });
    }

    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<ModelSettings>(&raw)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let Some(settings) = load_model_settings_from_fallbacks(fallback_paths)? {
                save_model_settings(path, &settings)?;
                return Ok(settings);
            }
            let defaults = default_model_settings();
            save_model_settings(path, &defaults)?;
            Ok(defaults)
        }
        Err(error) => Err(error),
    }
}

fn migrate_legacy_data_dir(
    legacy_base_dir: &PathBuf,
    target_base_dir: &PathBuf,
) -> Result<(), io::Error> {
    if !legacy_base_dir.exists() || legacy_base_dir == target_base_dir {
        return Ok(());
    }

    if !target_base_dir.exists() {
        fs::rename(legacy_base_dir, target_base_dir)?;
        return Ok(());
    }

    let legacy_entries = fs::read_dir(legacy_base_dir)?.collect::<Result<Vec<_>, _>>()?;
    if legacy_entries.is_empty() {
        fs::remove_dir_all(legacy_base_dir)?;
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataDirectoryMode {
    Workspace,
    InstallDir,
    AppData,
}

fn resolve_runtime_root() -> Result<PathBuf, io::Error> {
    let executable_path = env::current_exe()?;
    executable_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "无法定位应用运行目录"))
}

fn resolve_workspace_root(runtime_root: &Path) -> PathBuf {
    let workspace_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    match workspace_candidate.canonicalize() {
        Ok(path) => path,
        Err(_) => runtime_root.to_path_buf(),
    }
}

fn resolve_data_directory_mode() -> DataDirectoryMode {
    if let Some(value) = read_env_first(&["KNOWFLOW_DATA_MODE", "KNOWLEDGEOS_DATA_MODE"]) {
        if let Some(mode) = parse_data_directory_mode(value.trim()) {
            return mode;
        }
    }
    if cfg!(debug_assertions) {
        DataDirectoryMode::Workspace
    } else {
        DataDirectoryMode::InstallDir
    }
}

fn parse_data_directory_mode(value: &str) -> Option<DataDirectoryMode> {
    match value.to_ascii_lowercase().as_str() {
        "workspace" => Some(DataDirectoryMode::Workspace),
        "install" | "portable" => Some(DataDirectoryMode::InstallDir),
        "appdata" => Some(DataDirectoryMode::AppData),
        _ => None,
    }
}

fn resolve_base_directory(
    data_mode: DataDirectoryMode,
    workspace_root: &Path,
    runtime_root: &Path,
) -> Result<PathBuf, io::Error> {
    if let Some(custom_path) = read_env_first(&["KNOWFLOW_DATA_DIR", "KNOWLEDGEOS_DATA_DIR"]) {
        let trimmed = custom_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    match data_mode {
        DataDirectoryMode::Workspace => Ok(workspace_root.join(".knowledgeos")),
        DataDirectoryMode::InstallDir => Ok(runtime_root.join(".knowledgeos")),
        DataDirectoryMode::AppData => resolve_app_data_directory(),
    }
}

fn resolve_app_data_directory() -> Result<PathBuf, io::Error> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = env::var("LOCALAPPDATA")
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "缺少 LOCALAPPDATA 环境变量"))?;
        return Ok(PathBuf::from(local_app_data).join("KnowFlow"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
            let trimmed = xdg_data_home.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed).join("KnowFlow"));
            }
        }
        let home = env::var("HOME")
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "缺少 HOME 环境变量"))?;
        Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("KnowFlow"))
    }
}

fn resolve_parser_worker_path(workspace_root: &Path, runtime_root: &Path) -> Option<PathBuf> {
    if let Some(custom_path) = read_env_first(&[
        "KNOWFLOW_PARSER_WORKER_PATH",
        "KNOWLEDGEOS_PARSER_WORKER_PATH",
    ]) {
        let path = PathBuf::from(custom_path);
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates = vec![
        workspace_root
            .join("workers")
            .join("parser")
            .join("main.py"),
        runtime_root
            .join("resources")
            .join("workers")
            .join("parser")
            .join("main.py"),
        runtime_root.join("workers").join("parser").join("main.py"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("workers")
            .join("parser")
            .join("main.py"),
    ];

    if let Some(parent) = runtime_root.parent() {
        candidates.push(
            parent
                .join("Resources")
                .join("workers")
                .join("parser")
                .join("main.py"),
        );
    }

    candidates.into_iter().find(|path| path.exists())
}

fn resolve_migrations_dir(workspace_root: &Path, runtime_root: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        workspace_root
            .join("apps")
            .join("desktop")
            .join("src-tauri")
            .join("migrations"),
        runtime_root.join("resources").join("migrations"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations"),
    ];
    if let Some(parent) = runtime_root.parent() {
        candidates.push(parent.join("Resources").join("migrations"));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn resolve_prompt_templates_dir(workspace_root: &Path, runtime_root: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        workspace_root.join("packages").join("prompt-templates"),
        runtime_root.join("resources").join("prompt-templates"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("prompt-templates"),
    ];
    if let Some(parent) = runtime_root.parent() {
        candidates.push(parent.join("Resources").join("prompt-templates"));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn load_model_settings_from_fallbacks(
    fallback_paths: &[PathBuf],
) -> Result<Option<ModelSettings>, io::Error> {
    for fallback_path in fallback_paths {
        if !fallback_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(fallback_path)?;
        let parsed = serde_json::from_str::<ModelSettings>(&raw)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        return Ok(Some(parsed));
    }
    Ok(None)
}

fn default_model_settings() -> ModelSettings {
    ModelSettings {
        provider: "mock".to_string(),
        api_base_url: "https://api.deepseek.com/chat/completions".to_string(),
        api_key: String::new(),
        default_model: "deepseek-chat".to_string(),
        tool_model: "deepseek-chat".to_string(),
    }
}

fn save_model_settings(path: &PathBuf, settings: &ModelSettings) -> Result<(), io::Error> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    fs::write(path, content)
}

fn read_env_first(keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
