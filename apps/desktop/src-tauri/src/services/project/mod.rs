use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::Serialize;
use uuid::Uuid;

use crate::fs::{create_project_layout, slugify_project_name};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub project_id: String,
    pub name: String,
    pub description: Option<String>,
    pub root_path: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_project_record(
    connection: &Connection,
    projects_dir: &Path,
    name: &str,
    description: Option<&str>,
) -> Result<ProjectRecord, rusqlite::Error> {
    let now: DateTime<Utc> = Utc::now();
    let project_id = Uuid::new_v4().to_string();
    let slug = slugify_project_name(name);
    let root_path = projects_dir.join(format!("{}-{}", slug, &project_id[..8]));

    let project = ProjectRecord {
        project_id,
        name: name.to_string(),
        description: description.map(ToOwned::to_owned),
        root_path: root_path.to_string_lossy().into_owned(),
        status: "active".to_string(),
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };

    connection.execute(
        "INSERT INTO projects (project_id, name, description, root_path, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            project.project_id,
            project.name,
            project.description,
            project.root_path,
            project.status,
            project.created_at,
            project.updated_at
        ],
    )?;

    Ok(project)
}

pub fn initialize_project_directories(root_path: &str) -> Result<Vec<String>, std::io::Error> {
    create_project_layout(Path::new(root_path))
}

pub fn list_projects(connection: &Connection) -> Result<Vec<ProjectRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT project_id, name, description, root_path, status, created_at, updated_at
         FROM projects
         ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ProjectRecord {
            project_id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            root_path: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    rows.collect()
}

pub fn get_project(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<ProjectRecord>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT project_id, name, description, root_path, status, created_at, updated_at
         FROM projects
         WHERE project_id = ?1",
    )?;
    let mut rows = statement.query([project_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(ProjectRecord {
            project_id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            root_path: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}
