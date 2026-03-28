use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::config::AppConfig;
use crate::services::normalize::NormalizeResult;
use serde_json::Value;
use uuid::Uuid;
use wait_timeout::ChildExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[allow(dead_code)]
pub fn parser_health(config: &AppConfig) -> Result<serde_json::Value, String> {
    let mut command = build_python_command(&config.parser_worker_path);
    command.arg("health");
    let output = run_parser_command(&mut command, Duration::from_secs(20), "health")?;
    parse_json_output(output)
}

pub fn parse_document(
    config: &AppConfig,
    source_path: &str,
    source_type: &str,
    document_id: &str,
) -> Result<NormalizeResult, String> {
    let progress_path = build_parse_progress_path(config, document_id)?;
    let mut command = build_python_command(&config.parser_worker_path);
    command
        .arg("parse_file")
        .arg("--file-path")
        .arg(source_path)
        .arg("--source-type")
        .arg(source_type)
        .arg("--progress-path")
        .arg(&progress_path);
    let output = run_parser_command(
        &mut command,
        parser_timeout_for_source(source_type, source_path),
        "parse_file",
    )?;
    let payload = parse_json_output(output)?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

pub fn generate_presentation_pptx(
    config: &AppConfig,
    output_path: &str,
    presentation_json: &str,
) -> Result<serde_json::Value, String> {
    let mut command = build_python_command(&config.parser_worker_path);
    command
        .arg("generate_pptx")
        .arg("--output-path")
        .arg(output_path)
        .arg("--presentation-json")
        .arg(presentation_json);
    let output = run_parser_command(&mut command, Duration::from_secs(180), "generate_pptx")?;
    parse_json_output(output)
}

pub fn enhance_graph_with_networkx(
    config: &AppConfig,
    graph_payload: &Value,
) -> Result<Value, String> {
    let payload_path = build_graph_enhance_payload_path(config)?;
    let payload_text = serde_json::to_string(graph_payload).map_err(|error| error.to_string())?;
    fs::write(&payload_path, payload_text).map_err(|error| error.to_string())?;

    let mut command = build_python_command(&config.parser_worker_path);
    command
        .arg("enhance_graph")
        .arg("--graph-path")
        .arg(&payload_path);
    let output = run_parser_command(&mut command, Duration::from_secs(120), "enhance_graph");

    let _ = fs::remove_file(&payload_path);
    let output = output?;
    let payload = parse_json_output(output)?;
    let enhanced = payload
        .get("graph")
        .cloned()
        .ok_or_else(|| "NetworkX 增强返回缺少 graph 字段".to_string())?;
    Ok(enhanced)
}

fn build_python_command(worker_path: &std::path::Path) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("py");
        command.arg("-3").arg(worker_path);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("python3");
        command.arg(worker_path);
        command
    }
}

fn run_parser_command(
    command: &mut Command,
    timeout: Duration,
    task_name: &str,
) -> Result<std::process::Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdout_reader = child.stdout.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    });
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    });

    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| error.to_string())?
    {
        Some(status) => status,
        None => {
            child.kill().map_err(|error| error.to_string())?;
            let _ = child.wait();
            return Err(format!(
                "parser worker 执行超时（任务：{task_name}，超时：{} 秒）",
                timeout.as_secs()
            ));
        }
    };

    let stdout = stdout_reader
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = stderr_reader
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn parser_timeout_for_source(source_type: &str, source_path: &str) -> Duration {
    if let Some(timeout) = read_timeout_env(source_type) {
        return timeout;
    }

    let source_path = std::path::Path::new(source_path);
    let size_mb = fs::metadata(source_path)
        .ok()
        .map(|meta| meta.len() / (1024 * 1024))
        .unwrap_or(0);

    match source_type.to_ascii_lowercase().as_str() {
        "pdf" => {
            let secs = (600 + size_mb.saturating_mul(6)).clamp(600, 7200);
            Duration::from_secs(secs)
        }
        "pptx" | "docx" => {
            let secs = (180 + size_mb.saturating_mul(2)).clamp(180, 1800);
            Duration::from_secs(secs)
        }
        _ => Duration::from_secs(180),
    }
}

fn read_timeout_env(source_type: &str) -> Option<Duration> {
    let source_key = source_type.to_ascii_uppercase();
    let key_candidates = [
        format!("KNOWFLOW_{}_PARSER_TIMEOUT_SECS", source_key),
        format!("KNOWLEDGEOS_{}_PARSER_TIMEOUT_SECS", source_key),
        "KNOWFLOW_PARSER_TIMEOUT_SECS".to_string(),
        "KNOWLEDGEOS_PARSER_TIMEOUT_SECS".to_string(),
    ];

    for key in key_candidates {
        let parsed = std::env::var(&key)
            .ok()
            .and_then(|value| value.parse::<u64>().ok());
        if let Some(seconds) = parsed
            && (30..=21600).contains(&seconds)
        {
            return Some(Duration::from_secs(seconds));
        }
    }
    None
}

fn parse_json_output(output: std::process::Output) -> Result<serde_json::Value, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("sidecar 退出码异常: {}", output.status)
        } else {
            stderr
        });
    }

    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn build_parse_progress_path(config: &AppConfig, document_id: &str) -> Result<PathBuf, String> {
    let progress_dir = config.data_dir.join("progress");
    fs::create_dir_all(&progress_dir).map_err(|error| error.to_string())?;
    Ok(progress_dir.join(format!("{document_id}.json")))
}

fn build_graph_enhance_payload_path(config: &AppConfig) -> Result<PathBuf, String> {
    let temp_dir = config.data_dir.join("temp");
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    Ok(temp_dir.join(format!("graph-enhance-{}.json", Uuid::new_v4())))
}
