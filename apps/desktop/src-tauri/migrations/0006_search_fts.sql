CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61'
);
