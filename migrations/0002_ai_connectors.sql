-- CONNEXT INTELLIGENCE · motor de IA, conectores de entrada e funil comercial

CREATE TABLE connectors (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('webhook','google_sheets','hubspot','salesforce','postgres','mysql')),
  name              TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  config_json       TEXT NOT NULL DEFAULT '{}',   -- parâmetros não secretos (planilha, objeto, consulta, coluna incremental)
  secret_enc        TEXT,                         -- credencial cifrada com AES-GCM (chave VAULT_KEY do Worker)
  key_hash          TEXT,                         -- webhook: SHA-256 da chave de envio
  mapping_json      TEXT,                         -- cabeçalho de origem -> campo canônico, aprovado pelo usuário
  status            TEXT NOT NULL DEFAULT 'ativo',
  cursor            TEXT,                         -- posição incremental da última sincronização
  schedule_minutes  INTEGER NOT NULL DEFAULT 60,
  last_sync_at      INTEGER,
  last_result_json  TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  created_by        TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_connectors_due ON connectors(status, last_sync_at);

CREATE TABLE lead_stages (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL,
  stage       TEXT NOT NULL CHECK (stage IN ('novo','identificado','enriquecido','mql','sql','negociacao','cliente','descartado')),
  method      TEXT NOT NULL CHECK (method IN ('regra','ia','humano')),
  confidence  REAL,
  reason      TEXT,
  sig         TEXT,                               -- assinatura dos sinais usados; muda quando o lead muda
  model       TEXT,
  actor       TEXT,
  at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, entity_id)
);
CREATE INDEX idx_lead_stages_stage ON lead_stages(tenant_id, stage);

CREATE TABLE ai_analyses (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- arquivo | conector | etapas
  ref          TEXT,
  at           INTEGER NOT NULL,
  actor        TEXT,
  model        TEXT,
  result_json  TEXT,
  PRIMARY KEY (tenant_id, id)
);
