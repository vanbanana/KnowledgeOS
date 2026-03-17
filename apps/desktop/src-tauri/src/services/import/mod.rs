use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::jobs::{JobRecord, enqueue_job};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub document_id: String,
    pub project_id: String,
    pub source_path: String,
    pub source_type: String,
    pub source_hash: Option<String>,
    pub normalized_md_path: Option<String>,
    pub manifest_path: Option<String>,
    pub title: Option<String>,
    pub parse_status: String,
    pub imported_at: String,
    pub updated_at: Option<String>,
    pub last_error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentStatus {
    Imported,
    Parsing,
    Normalized,
    Chunked,
    Indexed,
    Ready,
    Failed,
}

impl DocumentStatus {
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Imported, Self::Parsing)
                | (Self::Imported, Self::Failed)
                | (Self::Parsing, Self::Normalized)
                | (Self::Parsing, Self::Failed)
                | (Self::Parsing, Self::Imported)
                | (Self::Normalized, Self::Chunked)
                | (Self::Normalized, Self::Failed)
                | (Self::Chunked, Self::Indexed)
                | (Self::Chunked, Self::Failed)
                | (Self::Indexed, Self::Ready)
                | (Self::Indexed, Self::Failed)
                | (Self::Failed, Self::Imported)
                | (Self::Failed, Self::Parsing)
        )
    }
}

impl Display for DocumentStatus {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Imported => "imported",
            Self::Parsing => "parsing",
            Self::Normalized => "normalized",
            Self::Chunked => "chunked",
            Self::Indexed => "indexed",
            Self::Ready => "ready",
            Self::Failed => "failed",
        };
        write!(f, "{value}")
    }
}

impl TryFrom<&str> for DocumentStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "imported" => Ok(Self::Imported),
            "parsing" => Ok(Self::Parsing),
            "normalized" => Ok(Self::Normalized),
            "chunked" => Ok(Self::Chunked),
            "indexed" => Ok(Self::Indexed),
            "ready" => Ok(Self::Ready),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("未知文档状态: {value}")),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportErrorRecord {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesResult {
    pub documents: Vec<DocumentRecord>,
    pub queued_job_ids: Vec<String>,
    pub errors: Vec<ImportErrorRecord>,
}

pub fn import_files(
    connection: &Connection,
    project_root: &Path,
    project_id: &str,
    paths: &[String],
) -> Result<ImportFilesResult, String> {
    let mut documents = Vec::new();
    let mut queued_job_ids = Vec::new();
    let mut errors = Vec::new();

    for raw_path in paths {
        match import_single_file(connection, project_root, project_id, raw_path) {
            Ok((document, maybe_job)) => {
                if let Some(job) = maybe_job {
                    queued_job_ids.push(job.job_id);
                }
                documents.push(document);
            }
            Err(error) => errors.push(ImportErrorRecord {
                path: raw_path.clone(),
                message: error,
            }),
        }
    }

    Ok(ImportFilesResult {
        documents,
        queued_job_ids,
        errors,
    })
}

fn import_single_file(
    connection: &Connection,
    project_root: &Path,
    project_id: &str,
    raw_path: &str,
) -> Result<(DocumentRecord, Option<JobRecord>), String> {
    let source_path = PathBuf::from(raw_path);
    if !source_path.exists() {
        let failed = create_failed_document_record(
            connection,
            project_id,
            raw_path,
            infer_source_type_from_path(&source_path),
            "文件不存在",
        )?;
        return Ok((failed, None));
    }

    let source_type = match infer_source_type(&source_path) {
        Ok(value) => value,
        Err(error) => {
            let failed = create_failed_document_record(
                connection,
                project_id,
                raw_path,
                infer_source_type_from_path(&source_path),
                &error,
            )?;
            return Ok((failed, None));
        }
    };
    let source_hash = calculate_source_hash(&source_path)?;
    if let Some(existing) = find_document_by_hash(connection, project_id, &source_hash)
        .map_err(|error| error.to_string())?
    {
        return Ok((existing, None));
    }
    let now: DateTime<Utc> = Utc::now();
    let document_id = Uuid::new_v4().to_string();
    let title = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法读取文件名".to_string())?;
    let target_path =
        project_root
            .join("source")
            .join(format!("{}-{}", &document_id[..8], file_name));

    fs::copy(&source_path, &target_path).map_err(|error| format!("复制文件失败: {error}"))?;

    let document = DocumentRecord {
        document_id: document_id.clone(),
        project_id: project_id.to_string(),
        source_path: target_path.to_string_lossy().into_owned(),
        source_type,
        source_hash: Some(source_hash),
        normalized_md_path: None,
        manifest_path: None,
        title,
        parse_status: DocumentStatus::Imported.to_string(),
        imported_at: now.to_rfc3339(),
        updated_at: Some(now.to_rfc3339()),
        last_error_message: None,
    };

    connection
        .execute(
            "INSERT INTO documents (
                document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
                parse_status, imported_at, updated_at, last_error_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                document.document_id,
                document.project_id,
                document.source_path,
                document.source_type,
                document.source_hash,
                document.normalized_md_path,
                document.manifest_path,
                document.title,
                document.parse_status,
                document.imported_at,
                document.updated_at,
                document.last_error_message
            ],
        )
        .map_err(|error| error.to_string())?;

    transition_document_status(
        connection,
        &document_id,
        DocumentStatus::Imported,
        DocumentStatus::Parsing,
        None,
    )?;

    let payload_json = serde_json::json!({
        "documentId": document_id,
        "projectId": project_id,
        "projectRoot": project_root.to_string_lossy().into_owned(),
        "sourcePath": target_path.to_string_lossy().into_owned()
    })
    .to_string();
    let job = enqueue_job(connection, "document.parse", &payload_json, 3)
        .map_err(|error| error.to_string())?;
    let persisted = get_document(connection, &document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "导入后未找到文档记录".to_string())?;

    Ok((persisted, Some(job)))
}

pub fn list_documents(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<DocumentRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
            parse_status, imported_at, updated_at, last_error_message
         FROM documents
         WHERE project_id = ?1
         ORDER BY imported_at DESC",
    )?;
    let rows = statement.query_map([project_id], map_document_row)?;
    rows.collect()
}

pub fn get_all_documents(connection: &Connection) -> Result<Vec<DocumentRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
            parse_status, imported_at, updated_at, last_error_message
         FROM documents
         ORDER BY imported_at DESC",
    )?;
    let rows = statement.query_map([], map_document_row)?;
    rows.collect()
}

pub fn find_document_by_hash(
    connection: &Connection,
    project_id: &str,
    source_hash: &str,
) -> Result<Option<DocumentRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
            parse_status, imported_at, updated_at, last_error_message
         FROM documents
         WHERE project_id = ?1 AND source_hash = ?2
         LIMIT 1",
    )?;
    let mut rows = statement.query([project_id, source_hash])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_document_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_document(
    connection: &Connection,
    document_id: &str,
) -> Result<Option<DocumentRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT
            document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
            parse_status, imported_at, updated_at, last_error_message
         FROM documents
         WHERE document_id = ?1",
    )?;
    let mut rows = statement.query([document_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_document_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn transition_document_status(
    connection: &Connection,
    document_id: &str,
    current: DocumentStatus,
    next: DocumentStatus,
    error_message: Option<&str>,
) -> Result<(), String> {
    if !current.can_transition_to(next) {
        return Err(format!("不允许从 {} 迁移到 {}", current, next));
    }

    let now: DateTime<Utc> = Utc::now();
    let affected = connection
        .execute(
            "UPDATE documents
             SET parse_status = ?1, updated_at = ?2, last_error_message = ?3
             WHERE document_id = ?4 AND parse_status = ?5",
            params![
                next.to_string(),
                now.to_rfc3339(),
                error_message,
                document_id,
                current.to_string()
            ],
        )
        .map_err(|error| error.to_string())?;

    if affected == 0 {
        return Err(format!("文档状态迁移失败，当前状态不是 {}", current));
    }

    Ok(())
}

fn infer_source_type(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "缺少文件扩展名".to_string())?;
    match extension.to_ascii_lowercase().as_str() {
        "pdf" => Ok("pdf".to_string()),
        "pptx" => Ok("pptx".to_string()),
        "docx" => Ok("docx".to_string()),
        "md" => Ok("md".to_string()),
        "txt" => Ok("txt".to_string()),
        _ => Err(format!("暂不支持的文件类型: .{extension}")),
    }
}

fn infer_source_type_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "pdf" | "pptx" | "docx" | "md" | "txt"))
        .unwrap_or_else(|| "unknown".to_string())
}

fn calculate_source_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn create_failed_document_record(
    connection: &Connection,
    project_id: &str,
    source_path: &str,
    source_type: String,
    error_message: &str,
) -> Result<DocumentRecord, String> {
    let now = Utc::now().to_rfc3339();
    let document = DocumentRecord {
        document_id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        source_path: source_path.to_string(),
        source_type,
        source_hash: None,
        normalized_md_path: None,
        manifest_path: None,
        title: Path::new(source_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
        parse_status: DocumentStatus::Failed.to_string(),
        imported_at: now.clone(),
        updated_at: Some(now),
        last_error_message: Some(error_message.to_string()),
    };

    connection
        .execute(
            "INSERT INTO documents (
                document_id, project_id, source_path, source_type, source_hash, normalized_md_path, manifest_path, title,
                parse_status, imported_at, updated_at, last_error_message
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                document.document_id,
                document.project_id,
                document.source_path,
                document.source_type,
                document.source_hash,
                document.normalized_md_path,
                document.manifest_path,
                document.title,
                document.parse_status,
                document.imported_at,
                document.updated_at,
                document.last_error_message
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(document)
}

fn map_document_row(row: &rusqlite::Row<'_>) -> Result<DocumentRecord, rusqlite::Error> {
    Ok(DocumentRecord {
        document_id: row.get(0)?,
        project_id: row.get(1)?,
        source_path: row.get(2)?,
        source_type: row.get(3)?,
        source_hash: row.get(4)?,
        normalized_md_path: row.get(5)?,
        manifest_path: row.get(6)?,
        title: row.get(7)?,
        parse_status: row.get(8)?,
        imported_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_error_message: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::DocumentStatus;

    #[test]
    fn 文档状态机应限制非法迁移() {
        assert!(DocumentStatus::Imported.can_transition_to(DocumentStatus::Parsing));
        assert!(DocumentStatus::Parsing.can_transition_to(DocumentStatus::Failed));
        assert!(!DocumentStatus::Imported.can_transition_to(DocumentStatus::Ready));
        assert!(!DocumentStatus::Ready.can_transition_to(DocumentStatus::Imported));
    }
}
