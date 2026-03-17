ALTER TABLE blocks ADD COLUMN title TEXT;
ALTER TABLE blocks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blocks ADD COLUMN updated_at TEXT;
ALTER TABLE blocks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blocks ADD COLUMN note TEXT;

CREATE TABLE IF NOT EXISTS reader_states (
  project_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  source_anchor TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (block_id) REFERENCES blocks(block_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_document_favorite ON blocks(document_id, is_favorite);
CREATE INDEX IF NOT EXISTS idx_reader_states_document ON reader_states(document_id, updated_at);
