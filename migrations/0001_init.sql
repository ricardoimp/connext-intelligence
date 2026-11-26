-- CONNEXT INTELLIGENCE · esquema inicial (Cloudflare D1 / SQLite)
-- Toda tabela de dados de cliente carrega tenant_id e é sempre filtrada por ele na API.
-- Colunas *_json guardam estruturas versionadas do motor; colunas soltas existem para filtro, índice e relatório.

PRAGMA foreign_keys = ON;

-- ============ Identidade, tenants e permissões ============
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  salt          TEXT NOT NULL,                 -- segredo para chaves de identidade derivadas (HMAC/hash) do tenant
  config_json   TEXT NOT NULL DEFAULT '{}',    -- pesos DQI, ICP, limiares, orçamento, retenção, workflows
  spend         REAL NOT NULL DEFAULT 0,       -- gasto com provedores no período
  seq           INTEGER NOT NULL DEFAULT 0,
  cache_hits    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ativo',
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE users (
  email         TEXT PRIMARY KEY,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE roles (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL
);

CREATE TABLE permissions (
  role_id  TEXT NOT NULL REFERENCES roles(id),
  action   TEXT NOT NULL,
  PRIMARY KEY (role_id, action)
);

CREATE TABLE memberships (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role_id     TEXT NOT NULL REFERENCES roles(id),
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  PRIMARY KEY (tenant_id, email)
);
CREATE INDEX idx_memberships_email ON memberships(email);

-- ============ Base legal, finalidades e fontes ============
CREATE TABLE legal_bases (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL
);

CREATE TABLE permitted_purposes (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL
);

CREATE TABLE data_sources (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT,
  origin        TEXT,
  owner         TEXT,
  legal_basis   TEXT,
  purposes_json TEXT NOT NULL DEFAULT '[]',
  reliability   REAL NOT NULL DEFAULT 0.5,
  contract      TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE source_contracts (
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  reference      TEXT,
  legal_basis    TEXT,
  purposes_json  TEXT NOT NULL DEFAULT '[]',
  valid_from     INTEGER,
  valid_until    INTEGER,
  notes          TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- ============ Ingestão (camada RAW/BRONZE em R2 + registros) ============
CREATE TABLE import_jobs (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  file_name     TEXT,
  file_hash     TEXT,
  format        TEXT,
  encoding      TEXT,
  bytes         INTEGER,
  version       INTEGER,
  status        TEXT NOT NULL,
  total         INTEGER,
  received      INTEGER,
  normalized    INTEGER,
  validated     INTEGER,
  row_errors    INTEGER,
  raw_key       TEXT,                          -- objeto original no bucket R2 connext-raw
  actor         TEXT,
  at            INTEGER,
  data_json     TEXT NOT NULL DEFAULT '{}',    -- mapeamento, contadores por etapa, tempos, erros por linha
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_import_jobs_hash ON import_jobs(tenant_id, file_hash);

CREATE TABLE source_records (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  import_id     TEXT,
  row_num       INTEGER,
  entity_type   TEXT,
  observed_at   INTEGER,
  payload_json  TEXT NOT NULL,                 -- afirmações por campo: valor bruto, normalizado, validade, motivo
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_source_records_import ON source_records(tenant_id, import_id);
CREATE INDEX idx_source_records_source ON source_records(tenant_id, source_id);

CREATE TABLE mapping_templates (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sig         TEXT NOT NULL,
  file_name   TEXT,
  map_json    TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 1,
  at          INTEGER,
  PRIMARY KEY (tenant_id, sig)
);

-- ============ Identidade e perfis mestres (GOLDEN/MASTER) ============
CREATE TABLE identity_keys (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,                   -- tipo:hash(salt|tipo|valor), nunca o valor em claro
  record_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key_hash, record_id)
);

CREATE TABLE identity_decisions (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pair_key    TEXT NOT NULL,                   -- "recA|recB" para merge/reject, "recX" para split
  kind        TEXT NOT NULL CHECK (kind IN ('merge','reject','split')),
  actor       TEXT,
  at          INTEGER,
  PRIMARY KEY (tenant_id, pair_key, kind)
);

CREATE TABLE identity_match_candidates (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pair_key      TEXT NOT NULL,
  score         REAL,
  reasons_json  TEXT,
  status        TEXT NOT NULL DEFAULT 'pendente',
  updated_at    INTEGER,
  PRIMARY KEY (tenant_id, pair_key)
);

CREATE TABLE canonical_entities (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,                 -- identificador imutável derivado do registro âncora
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('person','organization')),
  name          TEXT,
  level         INTEGER,
  dqi           INTEGER,
  completeness  INTEGER,
  confidence    INTEGER,
  freshness     INTEGER,
  qualification INTEGER,
  contactability INTEGER,
  record_count  INTEGER,
  org_id        TEXT,
  suppressed    INTEGER NOT NULL DEFAULT 0,
  elig_json     TEXT,                          -- elegibilidade bloqueante por finalidade
  sources_json  TEXT,
  golden_json   TEXT,                          -- valor vencedor, fonte, método, confiança e justificativa por campo
  sig           TEXT,                          -- assinatura do estado; muda quando o perfil muda
  updated_at    INTEGER,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_entities_level ON canonical_entities(tenant_id, level);
CREATE INDEX idx_entities_dqi ON canonical_entities(tenant_id, dqi);

CREATE TABLE golden_profile_versions (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id     TEXT NOT NULL,
  sig           TEXT NOT NULL,
  golden_json   TEXT,
  scores_json   TEXT,
  at            INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, entity_id, sig)
);

CREATE VIEW persons AS
  SELECT * FROM canonical_entities WHERE entity_type = 'person';
CREATE VIEW organizations AS
  SELECT * FROM canonical_entities WHERE entity_type = 'organization';
CREATE VIEW leads AS
  SELECT tenant_id, id, entity_type, name, level, dqi, qualification, contactability, suppressed, elig_json, updated_at
  FROM canonical_entities;
CREATE VIEW lead_organization_links AS
  SELECT tenant_id, id AS person_id, org_id AS organization_id
  FROM canonical_entities WHERE entity_type = 'person' AND org_id IS NOT NULL;

-- Afirmações e evidências por campo em formato relacional (alimentadas pelo motor no servidor, fase 2)
CREATE TABLE field_assertions (
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  entity_id            TEXT,
  record_id            TEXT,
  field_name           TEXT NOT NULL,
  field_value_encrypted TEXT,
  normalized_value     TEXT,
  source_id            TEXT,
  evidence_reference   TEXT,
  asserted_at          INTEGER,
  observed_at          INTEGER,
  verified_at          INTEGER,
  expires_at           INTEGER,
  extraction_method    TEXT,
  confidence_score     REAL,
  verification_status  TEXT,
  sensitivity_class    TEXT,
  permitted_purpose_ids TEXT,
  conflict_status      TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_assertions_entity ON field_assertions(tenant_id, entity_id, field_name);

CREATE TABLE field_evidence (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  assertion_id  TEXT NOT NULL,
  kind          TEXT,
  reference     TEXT,
  at            INTEGER,
  data_json     TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- ============ Qualidade e pontuação ============
CREATE TABLE data_quality_assessments (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  at            INTEGER NOT NULL,
  import_id     TEXT,
  records       INTEGER,
  entities      INTEGER,
  dqi           INTEGER,
  completeness  INTEGER,
  confidence    INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE scoring_models (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  at          INTEGER,
  dqi_json    TEXT,
  icp_json    TEXT,
  avg_dqi     INTEGER,
  PRIMARY KEY (tenant_id, version)
);

-- ============ Enriquecimento ============
CREATE TABLE enrichment_providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT,
  kind          TEXT,                          -- interno | externo | demo
  needs_json    TEXT,
  fields_json   TEXT,
  cost          REAL,
  confidence    REAL,
  purposes_json TEXT,
  contract      TEXT,
  status        TEXT
);

CREATE TABLE enrichment_requests (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  at          INTEGER,
  actor       TEXT,
  state       TEXT,
  cost        REAL,
  filled      INTEGER,
  data_json   TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE enrichment_results (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  field         TEXT NOT NULL,
  value         TEXT,
  provider      TEXT,
  run_id        TEXT,
  at            INTEGER,
  method        TEXT,
  verification  TEXT,
  note          TEXT,
  confidence    REAL,
  synthetic     INTEGER NOT NULL DEFAULT 0,
  cost          REAL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_enrichment_record ON enrichment_results(tenant_id, record_id);

CREATE TABLE enrichment_cache (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, cache_key)
);

-- ============ Workflows, segmentos e agentes ============
CREATE TABLE workflow_executions (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  kind        TEXT,
  trigger     TEXT,
  ref         TEXT,
  at          INTEGER,
  state       TEXT,
  attempts    INTEGER,
  ms          INTEGER,
  cost        REAL,
  detail      TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE segments (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  name             TEXT,
  purpose          TEXT,
  definition_json  TEXT,
  at               INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE agent_executions (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  agent         TEXT,
  model         TEXT,
  at            INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost          REAL,
  data_json     TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- ============ Privacidade e governança ============
CREATE TABLE consent_events (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  entity_id   TEXT,
  channel     TEXT,
  value       TEXT,
  source_id   TEXT,
  at          INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE suppression_registry (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,                   -- só a chave derivada, nunca o canal em claro
  channel     TEXT,
  reason      TEXT,
  at          INTEGER,
  PRIMARY KEY (tenant_id, key_hash)
);

CREATE TABLE erasure_requests (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  ref_hash    TEXT,
  records     INTEGER,
  at          INTEGER,
  actor       TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE audit_events (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  at          INTEGER NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  ref         TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_audit_at ON audit_events(tenant_id, at);

-- ============ Consumo e faturamento ============
CREATE TABLE api_usage (
  tenant_id   TEXT NOT NULL,
  day         TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, endpoint)
);

CREATE TABLE billing_events (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  at          INTEGER,
  kind        TEXT,
  quantity    REAL,
  amount      REAL,
  data_json   TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- ============ Dados de referência ============
INSERT INTO roles (id, label) VALUES
  ('admin', 'Administrador'), ('analista', 'Analista de dados'), ('leitor', 'Leitor');

INSERT INTO permissions (role_id, action) VALUES
  ('admin','import'),('admin','merge'),('admin','enrich'),('admin','approve'),('admin','segment'),('admin','export'),('admin','govern'),('admin','config'),('admin','members'),
  ('analista','import'),('analista','merge'),('analista','enrich'),('analista','segment');

INSERT INTO legal_bases (id, label) VALUES
  ('consentimento','Consentimento'), ('legitimo_interesse','Legítimo interesse'),
  ('execucao_contrato','Execução de contrato'), ('obrigacao_legal','Obrigação legal');

INSERT INTO permitted_purposes (id, label) VALUES
  ('analytics','Análise interna'), ('enrichment','Enriquecimento'),
  ('marketing_contact','Contato de marketing'), ('sales_contact','Contato comercial');

INSERT INTO enrichment_providers (id, name, category, kind, needs_json, fields_json, cost, confidence, purposes_json, contract, status) VALUES
  ('ddd_uf','Tabela DDD → UF','Derivação interna determinística','interno','["phone"]','["state"]',0,0.8,'["analytics","enrichment"]','Tabela pública de numeração','ativo'),
  ('master_link','Vínculo com organização do master','Cruzamento interno do próprio tenant','interno','["email"]','["org_name","segment"]',0,0.7,'["analytics","enrichment"]','Dados do próprio tenant','ativo'),
  ('domain_site','Domínio corporativo → website','Derivação interna','interno','["email"]','["website"]',0,0.5,'["analytics","enrichment"]','Derivado do e-mail informado','ativo'),
  ('demo_b2b','Provedor B2B (adaptador de demonstração)','Provedor B2B licenciado','demo','["email"]','["job_title"]',0.35,0,'["enrichment"]','Nenhum: valores sintéticos','demonstração'),
  ('cnpj_oficial','Cadastro empresarial oficial (CNPJ)','Cadastro empresarial oficial','externo','["cnpj"]','["org_name","segment","address","city","state","cep"]',0.02,0.95,'["analytics","enrichment"]','A contratar','indisponível');
