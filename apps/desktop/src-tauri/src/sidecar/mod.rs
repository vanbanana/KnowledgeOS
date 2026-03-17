use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::config::AppConfig;
use crate::services::normalize::NormalizeResult;
use wait_timeout::ChildExt;

#[allow(dead_code)]
pub fn parser_health(config: &AppConfig) -> Result<serde_json::Value, String> {
    let output = run_parser_command(
        Command::new("python")
            .arg(&config.parser_worker_path)
            .arg("health"),
    )?;
    parse_json_output(output)
}

pub fn parse_document(
    config: &AppConfig,
    source_path: &str,
    source_type: &str,
) -> Result<NormalizeResult, String> {
    let output = run_parser_command(
        Command::new("python")
            .arg(&config.parser_worker_path)
            .arg("parse_file")
            .arg("--file-path")
            .arg(source_path)
            .arg("--source-type")
            .arg(source_type),
    )?;
    let payload = parse_json_output(output)?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

fn run_parser_command(command: &mut Command) -> Result<std::process::Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let timeout = Duration::from_secs(60);

    match child
        .wait_timeout(timeout)
        .map_err(|error| error.to_string())?
    {
        Some(_) => {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut pipe) = child.stdout.take() {
                let _ = pipe.read_to_end(&mut stdout);
            }
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_end(&mut stderr);
            }
            Ok(std::process::Output {
                status: child.wait().map_err(|error| error.to_string())?,
                stdout,
                stderr,
            })
        }
        None => {
            child.kill().map_err(|error| error.to_string())?;
            let _ = child.wait();
            Err("parser worker 执行超时".to_string())
        }
    }
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
