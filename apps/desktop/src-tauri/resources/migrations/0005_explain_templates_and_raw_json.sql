CREATE TABLE IF NOT EXISTS explain_templates (
  prompt_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  output_schema_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (prompt_version, mode)
);

ALTER TABLE block_explanations ADD COLUMN examples_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE block_explanations ADD COLUMN raw_response_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_block_explanations_cache_key ON block_explanations(cache_key);
