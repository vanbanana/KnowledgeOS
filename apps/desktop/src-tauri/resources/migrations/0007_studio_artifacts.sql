CREATE TABLE IF NOT EXISTS studio_artifacts (
    artifact_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    source_document_ids_json TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    current_stage TEXT,
    output_path TEXT,
    preview_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_studio_artifacts_project_created
ON studio_artifacts(project_id, created_at DESC);
