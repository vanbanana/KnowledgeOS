use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::config::AppConfig;
use crate::services::normalize::{ManifestSection, NormalizeResult, NormalizedManifest};
use reqwest::blocking::Client;
use serde_json::Value;
use wait_timeout::ChildExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DEFAULT_OCR_PDF_ENDPOINT: &str = "http://106.12.174.212/ocr/pdf";
const PDF_EMPTY_PLACEHOLDER: &str = "当前 PDF 没有提取到可转换的正文内容";

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
    let mut normalized: NormalizeResult =
        serde_json::from_value(payload).map_err(|error| error.to_string())?;

    if source_type.eq_ignore_ascii_case("pdf") && should_fallback_to_ocr(&normalized) {
        if should_auto_ocr() {
            let _ = write_progress_json(
                &progress_path,
                serde_json::json!({
                    "phase": "ocr_processing",
                    "message": "检测到扫描页，正在调用 OCR 服务…"
                }),
            );
            match parse_pdf_with_ocr(source_path, &normalized) {
                Ok(ocr_result) => {
                    normalized = ocr_result;
                    let _ = write_progress_json(
                        &progress_path,
                        serde_json::json!({
                            "phase": "ocr_completed",
                            "message": "OCR 处理完成，正在进入分块阶段。"
                        }),
                    );
                }
                Err(error) => {
                    let warning = format!("检测到扫描件 PDF，但 OCR 服务调用失败：{error}");
                    if !normalized
                        .manifest
                        .warnings
                        .iter()
                        .any(|item| item == &warning)
                    {
                        normalized.manifest.warnings.push(warning);
                    }
                }
            }
        } else {
            let warning = "检测到扫描件 PDF，已按极速模式跳过自动 OCR（可通过 KNOWFLOW_AUTO_OCR=true 开启）";
            if !normalized.manifest.warnings.iter().any(|item| item == warning) {
                normalized.manifest.warnings.push(warning.to_string());
            }
            let _ = write_progress_json(
                &progress_path,
                serde_json::json!({
                    "phase": "ocr_skipped",
                    "message": "已跳过自动 OCR，正在进入分块阶段。"
                }),
            );
        }
    }

    Ok(normalized)
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
            Err(format!(
                "parser worker 执行超时（任务：{task_name}，超时：{} 秒）",
                timeout.as_secs()
            ))
        }
    }
}

fn parser_timeout_for_source(source_type: &str, source_path: &str) -> Duration {
    if let Some(timeout) = read_timeout_env(source_type) {
        return timeout;
    }

    let source_path = Path::new(source_path);
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

fn should_fallback_to_ocr(result: &NormalizeResult) -> bool {
    let markdown = result.markdown.trim();
    if markdown.is_empty() || markdown.contains(PDF_EMPTY_PLACEHOLDER) {
        return true;
    }

    result
        .manifest
        .warnings
        .iter()
        .any(|item| item.contains("未提取到正文") || item.contains("扫描件"))
}

fn should_auto_ocr() -> bool {
    ["KNOWFLOW_AUTO_OCR", "KNOWLEDGEOS_AUTO_OCR"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .any(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn parse_pdf_with_ocr(
    source_path: &str,
    fallback: &NormalizeResult,
) -> Result<NormalizeResult, String> {
    let pdf_path = Path::new(source_path);
    if !pdf_path.exists() {
        return Err(format!("OCR 文件不存在：{source_path}"));
    }

    let boundary = format!("----KnowFlowOCR{}", uuid::Uuid::new_v4().simple());
    let request_body = build_multipart_body(pdf_path, &boundary)?;
    let endpoint = resolve_ocr_pdf_endpoint();
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(ocr_timeout_for_file(pdf_path))
        .build()
        .map_err(|error| format!("初始化 OCR 客户端失败：{error}"))?;

    let response = client
        .post(&endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(request_body)
        .send()
        .map_err(|error| format!("请求 OCR 服务失败：{error}"))?;

    let status = response.status();
    let response_text = response
        .text()
        .map_err(|error| format!("读取 OCR 响应失败：{error}"))?;
    if !status.is_success() {
        let reason = response_text.trim();
        if reason.is_empty() {
            return Err(format!("OCR 服务返回错误状态：{status}"));
        }
        return Err(format!("OCR 服务返回错误状态：{status}，响应：{reason}"));
    }

    let payload: Value = serde_json::from_str(&response_text)
        .map_err(|error| format!("解析 OCR 响应失败：{error}"))?;
    if payload
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|ok| !ok)
    {
        let message = pick_text_field(&payload, &["message", "error"])
            .unwrap_or_else(|| "OCR 处理失败".to_string());
        return Err(message);
    }

    let full_text = pick_text_field(&payload, &["full_text", "fulltext", "full text"]);
    let pages = extract_ocr_pages(&payload);
    let has_page_text = pages.iter().any(|(_, text)| !text.trim().is_empty());
    let has_full_text = full_text
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty());
    if !has_full_text && !has_page_text {
        return Err("OCR 未识别到可用文本".to_string());
    }

    let title = if fallback.manifest.title.trim().is_empty() {
        pdf_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("扫描件")
            .to_string()
    } else {
        fallback.manifest.title.clone()
    };

    let markdown = build_ocr_markdown(&title, full_text.as_deref(), &pages);
    let mut warnings: Vec<String> = fallback
        .manifest
        .warnings
        .iter()
        .filter(|item| !item.contains(PDF_EMPTY_PLACEHOLDER) && !item.contains("未提取到正文"))
        .cloned()
        .collect();
    warnings.push("检测到扫描件 PDF，已自动调用 OCR 服务提取文本。".to_string());
    if let Some(total_pages) = pick_numeric_field(&payload, &["total_pages", "total pages"]) {
        warnings.push(format!("OCR 共识别 {total_pages} 页。"));
    }

    Ok(NormalizeResult {
        ok: true,
        markdown,
        manifest: NormalizedManifest {
            title,
            source_type: fallback.manifest.source_type.clone(),
            source_path: fallback.manifest.source_path.clone(),
            sections: build_ocr_sections(&pages),
            assets: fallback.manifest.assets.clone(),
            warnings,
        },
    })
}

fn build_multipart_body(pdf_path: &Path, boundary: &str) -> Result<Vec<u8>, String> {
    let filename = pdf_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf")
        .replace('\"', "_");
    let file_bytes = fs::read(pdf_path).map_err(|error| format!("读取 PDF 失败：{error}"))?;

    let mut body = Vec::with_capacity(file_bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/pdf\r\n\r\n");
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok(body)
}

fn ocr_timeout_for_file(pdf_path: &Path) -> Duration {
    let size_mb = fs::metadata(pdf_path)
        .ok()
        .map(|meta| meta.len() / (1024 * 1024))
        .unwrap_or(0);
    let secs = (300 + size_mb.saturating_mul(10)).clamp(300, 10800);
    Duration::from_secs(secs)
}

fn build_parse_progress_path(config: &AppConfig, document_id: &str) -> Result<PathBuf, String> {
    let progress_dir = config.data_dir.join("progress");
    fs::create_dir_all(&progress_dir).map_err(|error| error.to_string())?;
    Ok(progress_dir.join(format!("{document_id}.json")))
}

fn write_progress_json(path: &Path, payload: serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    fs::write(path, body).map_err(|error| error.to_string())
}

fn resolve_ocr_pdf_endpoint() -> String {
    std::env::var("KNOWFLOW_OCR_PDF_ENDPOINT")
        .or_else(|_| std::env::var("KNOWLEDGEOS_OCR_PDF_ENDPOINT"))
        .unwrap_or_else(|_| DEFAULT_OCR_PDF_ENDPOINT.to_string())
}

fn pick_text_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn pick_numeric_field(payload: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_u64))
}

fn extract_ocr_pages(payload: &Value) -> Vec<(usize, String)> {
    let mut pages = Vec::new();
    let Some(items) = payload.get("pages").and_then(Value::as_array) else {
        return pages;
    };

    for (index, item) in items.iter().enumerate() {
        let page = item
            .get("page")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(index + 1);
        if let Some(text) = pick_text_field(item, &["full_text", "fulltext", "full text"]) {
            pages.push((page, text));
        }
    }

    pages
}

fn build_ocr_markdown(title: &str, full_text: Option<&str>, pages: &[(usize, String)]) -> String {
    let mut markdown = format!("# {title}\n\n");
    if let Some(text) = full_text {
        markdown.push_str(text.trim());
        markdown.push('\n');
        return markdown;
    }

    if pages.is_empty() {
        markdown.push_str("OCR 未识别到可用文字内容。");
        return markdown;
    }

    for (index, (page, text)) in pages.iter().enumerate() {
        markdown.push_str(&format!("## 第{page}页\n\n"));
        markdown.push_str(text.trim());
        if index + 1 < pages.len() {
            markdown.push_str("\n\n");
        } else {
            markdown.push('\n');
        }
    }

    markdown
}

fn build_ocr_sections(pages: &[(usize, String)]) -> Vec<ManifestSection> {
    if pages.is_empty() {
        return vec![ManifestSection {
            heading: Some("全文".to_string()),
            anchor: "document-1".to_string(),
            index: 0,
        }];
    }

    pages
        .iter()
        .enumerate()
        .map(|(index, (page, _))| ManifestSection {
            heading: Some(format!("第{page}页")),
            anchor: format!("page-{page}"),
            index,
        })
        .collect()
}
