-- CONNEXT INTELLIGENCE · conexão por API REST paginada (ex.: API de cadastros Alpha FM)
-- O SQLite não altera CHECK de coluna: a tabela de conexões é recriada aceitando o novo tipo.
CREATE TABLE connectors_new (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('webhook','google_sheets','hubspot','salesforce','postgres','mysql','api_rest')),
  name              TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  config_json       TEXT NOT NULL DEFAULT '{}',
  secret_enc        TEXT,
  key_hash          TEXT,
  mapping_json      TEXT,
  status            TEXT NOT NULL DEFAULT 'ativo',
  cursor            TEXT,
  schedule_minutes  INTEGER NOT NULL DEFAULT 60,
  last_sync_at      INTEGER,
  last_result_json  TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  created_by        TEXT,
  PRIMARY KEY (tenant_id, id)
);
INSERT INTO connectors_new SELECT tenant_id, id, type, name, source_id, config_json, secret_enc, key_hash, mapping_json, status, cursor, schedule_minutes, last_sync_at, last_result_json, last_error, created_at, created_by FROM connectors;
DROP TABLE connectors;
ALTER TABLE connectors_new RENAME TO connectors;
CREATE INDEX idx_connectors_due ON connectors(status, last_sync_at);
CREATE INDEX IF NOT EXISTS idx_source_records_created ON source_records(tenant_id, created_at);
