use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::Serialize;
use uuid::Uuid;

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
        status: "pending".to_string(),
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

    let rows = statement.query_map([], |row| {
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
    })?;

    rows.collect()
}
