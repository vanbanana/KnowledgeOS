use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSection {
    pub heading: Option<String>,
    pub anchor: String,
    pub index: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedManifest {
    pub title: String,
    pub source_type: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub sections: Vec<ManifestSection>,
    #[serde(default)]
    pub assets: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeResult {
    pub ok: bool,
    pub markdown: String,
    pub manifest: NormalizedManifest,
}

pub fn write_normalized_result(
    connection: &Connection,
    project_root: &Path,
    document_id: &str,
    result: &NormalizeResult,
) -> Result<(PathBuf, PathBuf), String> {
    let docs_dir = project_root.join("normalized").join("docs");
    let manifests_dir = project_root.join("normalized").join("manifests");
    fs::create_dir_all(&docs_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&manifests_dir).map_err(|error| error.to_string())?;

    let markdown_path = docs_dir.join(format!("{document_id}.md"));
    let manifest_path = manifests_dir.join(format!("{document_id}.json"));

    fs::write(&markdown_path, &result.markdown).map_err(|error| error.to_string())?;
    let manifest_json =
        serde_json::to_string_pretty(&result.manifest).map_err(|error| error.to_string())?;
    fs::write(&manifest_path, manifest_json).map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE documents
             SET normalized_md_path = ?1, manifest_path = ?2, title = ?3, updated_at = ?4
             WHERE document_id = ?5",
            params![
                markdown_path.to_string_lossy().into_owned(),
                manifest_path.to_string_lossy().into_owned(),
                result.manifest.title,
                Utc::now().to_rfc3339(),
                document_id
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok((markdown_path, manifest_path))
}
