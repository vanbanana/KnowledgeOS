use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::services::import::{DocumentStatus, get_document, transition_document_status};
use crate::services::normalize::write_normalized_result;
use crate::sidecar::parse_document;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub job_id: String,
    pub kind: String,
    pub payload_json: String,
    pub status: String,
    pub error_message: Option<String>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentParsePayload {
    document_id: String,
    project_root: String,
    source_path: String,
}

pub fn enqueue_job(
    connection: &Connection,
    kind: &str,
    payload_json: &str,
    max_attempts: i64,
) -> Result<JobRecord, rusqlite::Error> {
    let now: DateTime<Utc> = Utc::now();
    let job = JobRecord {
        job_id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        payload_json: payload_json.to_string(),
        status: JobStatus::Pending.as_str().to_string(),
        error_message: None,
        attempts: 0,
        max_attempts,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };

    connection.execute(
        "INSERT INTO jobs (
            job_id, kind, payload_json, status, error_message, attempts, max_attempts, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            job.job_id,
            job.kind,
            job.payload_json,
            job.status,
            job.error_message,
            job.attempts,
            job.max_attempts,
            job.created_at,
            job.updated_at
        ],
    )?;

    Ok(job)
}

pub fn list_jobs(connection: &Connection) -> Result<Vec<JobRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT job_id, kind, payload_json, status, error_message, attempts, max_attempts, created_at, updated_at
         FROM jobs
         ORDER BY created_at DESC",
    )?;

    let rows = statement.query_map([], map_job_row)?;
    rows.collect()
}

pub fn get_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<JobRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT job_id, kind, payload_json, status, error_message, attempts, max_attempts, created_at, updated_at
         FROM jobs
         WHERE job_id = ?1",
    )?;
    let mut rows = statement.query([job_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_job_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn cancel_job(connection: &Connection, job_id: &str) -> Result<JobRecord, String> {
    let job = get_job(connection, job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;

    if job.kind == "document.parse" {
        let payload: DocumentParsePayload =
            serde_json::from_str(&job.payload_json).map_err(|error| error.to_string())?;
        if let Some(document) =
            get_document(connection, &payload.document_id).map_err(|error| error.to_string())?
            && document.parse_status == DocumentStatus::Parsing.to_string()
        {
            let _ = transition_document_status(
                connection,
                &payload.document_id,
                DocumentStatus::Parsing,
                DocumentStatus::Imported,
                Some("解析任务已取消"),
            );
        }
    }

    update_job_status(connection, job_id, JobStatus::Cancelled, Some("已手动取消"))
}

pub fn retry_job(connection: &Connection, job_id: &str) -> Result<JobRecord, String> {
    let affected = connection
        .execute(
            "UPDATE jobs
             SET status = ?1, error_message = NULL, updated_at = ?2
             WHERE job_id = ?3 AND status = ?4",
            params![
                JobStatus::Pending.as_str(),
                Utc::now().to_rfc3339(),
                job_id,
                JobStatus::Failed.as_str()
            ],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("只有 failed 任务可以重试".to_string());
    }
    get_job(connection, job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

pub fn run_job(
    connection: &Connection,
    config: &AppConfig,
    job_id: &str,
) -> Result<JobRecord, String> {
    let job = get_job(connection, job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务不存在".to_string())?;

    if job.status != JobStatus::Pending.as_str() {
        return Err("只有 pending 任务可以执行".to_string());
    }

    mark_job_running(connection, &job)?;

    match execute_job(connection, config, &job) {
        Ok(()) => update_job_status(connection, job_id, JobStatus::Succeeded, None),
        Err(error) => {
            let _ = update_job_failure(connection, job_id, &error);
            Err(error)
        }
    }
}

fn execute_job(connection: &Connection, config: &AppConfig, job: &JobRecord) -> Result<(), String> {
    match job.kind.as_str() {
        "document.parse" => execute_document_parse_job(connection, config, &job.payload_json),
        _ => Ok(()),
    }
}

fn execute_document_parse_job(
    connection: &Connection,
    config: &AppConfig,
    payload_json: &str,
) -> Result<(), String> {
    let payload: DocumentParsePayload =
        serde_json::from_str(payload_json).map_err(|error| error.to_string())?;
    let document = get_document(connection, &payload.document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文档不存在".to_string())?;
    if document.parse_status == DocumentStatus::Failed.to_string() {
        transition_document_status(
            connection,
            &payload.document_id,
            DocumentStatus::Failed,
            DocumentStatus::Parsing,
            None,
        )?;
    }
    let normalized = match parse_document(config, &payload.source_path, &document.source_type) {
        Ok(value) => value,
        Err(error) => {
            let _ = transition_document_status(
                connection,
                &payload.document_id,
                DocumentStatus::Parsing,
                DocumentStatus::Failed,
                Some(&error),
            );
            return Err(error);
        }
    };
    if !normalized.ok {
        transition_document_status(
            connection,
            &payload.document_id,
            DocumentStatus::Parsing,
            DocumentStatus::Failed,
            Some("parser worker 返回失败"),
        )?;
        return Err("parser worker 返回失败".to_string());
    }

    let project_root = PathBuf::from(&payload.project_root);
    if let Err(error) =
        write_normalized_result(connection, &project_root, &payload.document_id, &normalized)
    {
        let _ = transition_document_status(
            connection,
            &payload.document_id,
            DocumentStatus::Parsing,
            DocumentStatus::Failed,
            Some(&error),
        );
        return Err(error);
    }
    transition_document_status(
        connection,
        &payload.document_id,
        DocumentStatus::Parsing,
        DocumentStatus::Normalized,
        None,
    )?;
    Ok(())
}

fn mark_job_running(connection: &Connection, job: &JobRecord) -> Result<(), String> {
    let affected = connection
        .execute(
            "UPDATE jobs
             SET status = ?1, attempts = attempts + 1, updated_at = ?2
             WHERE job_id = ?3 AND status = ?4",
            params![
                JobStatus::Running.as_str(),
                Utc::now().to_rfc3339(),
                job.job_id,
                JobStatus::Pending.as_str()
            ],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("任务进入 running 状态失败".to_string());
    }
    Ok(())
}

fn update_job_failure(
    connection: &Connection,
    job_id: &str,
    error_message: &str,
) -> Result<JobRecord, String> {
    update_job_status(connection, job_id, JobStatus::Failed, Some(error_message))
}

fn update_job_status(
    connection: &Connection,
    job_id: &str,
    status: JobStatus,
    error_message: Option<&str>,
) -> Result<JobRecord, String> {
    let affected = connection
        .execute(
            "UPDATE jobs
             SET status = ?1, error_message = ?2, updated_at = ?3
             WHERE job_id = ?4",
            params![
                status.as_str(),
                error_message,
                Utc::now().to_rfc3339(),
                job_id
            ],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("任务不存在".to_string());
    }
    get_job(connection, job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务不存在".to_string())
}

fn map_job_row(row: &rusqlite::Row<'_>) -> Result<JobRecord, rusqlite::Error> {
    Ok(JobRecord {
        job_id: row.get(0)?,
        kind: row.get(1)?,
        payload_json: row.get(2)?,
        status: row.get(3)?,
        error_message: row.get(4)?,
        attempts: row.get(5)?,
        max_attempts: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use uuid::Uuid;

    use super::{JobStatus, get_job, run_job};
    use crate::config::AppConfig;
    use crate::db::initialize_database;
    use crate::services::import::{DocumentStatus, import_files, list_documents};
    use crate::services::project::{create_project_record, initialize_project_directories};

    #[test]
    fn 应可完成导入并运行解析任务() {
        let temp_root = std::env::temp_dir().join(format!("knowledgeos-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("创建临时目录失败");
        let data_dir = temp_root.join(".knowledgeos").join("data");
        let log_dir = temp_root.join(".knowledgeos").join("logs");
        let projects_dir = data_dir.join("projects");
        fs::create_dir_all(&projects_dir).expect("创建 projects 目录失败");
        fs::create_dir_all(&log_dir).expect("创建 log 目录失败");

        let database_path = data_dir.join("app.db");
        let migrations_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let connection =
            initialize_database(&database_path, &migrations_dir).expect("初始化数据库失败");

        let parser_worker_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("workers")
            .join("parser")
            .join("main.py");
        let config = AppConfig {
            app_name: "KnowledgeOS".to_string(),
            workspace_root: temp_root.clone(),
            data_dir: data_dir.clone(),
            log_dir: log_dir.clone(),
            projects_dir: projects_dir.clone(),
            database_path: database_path.clone(),
            parser_worker_path,
        };

        let project = create_project_record(&connection, &projects_dir, "测试项目", None)
            .expect("创建项目失败");
        initialize_project_directories(&project.root_path).expect("初始化项目目录失败");

        let source = temp_root.join("sample.md");
        fs::write(&source, "# 测试标题\n\n这里是测试内容。").expect("写入样本文档失败");

        let import_result = import_files(
            &connection,
            PathBuf::from(&project.root_path).as_path(),
            &project.project_id,
            &[source.to_string_lossy().into_owned()],
        )
        .expect("导入文件失败");

        let job_id = import_result
            .queued_job_ids
            .first()
            .cloned()
            .expect("应创建解析任务");
        let job = run_job(&connection, &config, &job_id).expect("运行解析任务失败");
        assert_eq!(job.status, JobStatus::Succeeded.as_str());

        let documents = list_documents(&connection, &project.project_id).expect("查询文档失败");
        assert_eq!(
            documents[0].parse_status,
            DocumentStatus::Normalized.to_string()
        );
        let normalized_path = PathBuf::from(
            documents[0]
                .normalized_md_path
                .clone()
                .expect("应写出 normalized markdown"),
        );
        assert!(normalized_path.exists());

        let persisted_job = get_job(&connection, &job_id)
            .expect("查询任务失败")
            .expect("任务应存在");
        assert_eq!(persisted_job.status, JobStatus::Succeeded.as_str());
    }
}
