-- CONNEXT INTELLIGENCE · perfis calculados no servidor
-- Cada registro ganha o perfil a que pertence. Índices de chaves fortes (CPF, CNPJ, e-mail, telefone) e de nomes
-- ligam registros novos aos perfis existentes; uma fila recalcula só os componentes afetados, sempre inteiros,
-- para o resultado ser idêntico ao recálculo completo do tenant.
ALTER TABLE source_records ADD COLUMN entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_records_entity ON source_records(tenant_id, entity_id);
CREATE TABLE IF NOT EXISTS record_keys (
  tenant_id TEXT NOT NULL, k TEXT NOT NULL, record_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, k, record_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_record_keys_rec ON record_keys(tenant_id, record_id);
CREATE TABLE IF NOT EXISTS record_names (
  tenant_id TEXT NOT NULL, k TEXT NOT NULL, record_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, k, record_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_record_names_rec ON record_names(tenant_id, record_id);
CREATE TABLE IF NOT EXISTS profile_queue (
  tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT, at INTEGER NOT NULL, indexed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, record_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_queue_indexed ON profile_queue(tenant_id, indexed);
ALTER TABLE canonical_entities ADD COLUMN card_json TEXT;   -- cartão compacto lido pela interface
CREATE INDEX IF NOT EXISTS idx_entities_updated ON canonical_entities(tenant_id, updated_at);
CREATE TABLE IF NOT EXISTS entity_tombstones (tenant_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_tombstones_at ON entity_tombstones(tenant_id, at);
CREATE TABLE IF NOT EXISTS tenant_stats (tenant_id TEXT PRIMARY KEY, stats_json TEXT, dirty INTEGER NOT NULL DEFAULT 1, cands_dirty INTEGER NOT NULL DEFAULT 1, at INTEGER, refreshed_at INTEGER);
-- pares para revisão: perfis envolvidos e origem (chave forte do componente ou mesmo nome, passo global)
ALTER TABLE identity_match_candidates ADD COLUMN ent_a TEXT;
ALTER TABLE identity_match_candidates ADD COLUMN ent_b TEXT;
ALTER TABLE identity_match_candidates ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_cands_ents ON identity_match_candidates(tenant_id, ent_a, ent_b);
-- modo de cálculo: browser (antigo), migrating (servidor reconstruindo), server
ALTER TABLE tenants ADD COLUMN profiles_mode TEXT NOT NULL DEFAULT 'server';
ALTER TABLE tenants ADD COLUMN profile_lock_until INTEGER;
UPDATE tenants SET profiles_mode = 'migrating' WHERE id IN (SELECT DISTINCT tenant_id FROM source_records);
DELETE FROM identity_match_candidates WHERE tenant_id IN (SELECT id FROM tenants WHERE profiles_mode = 'migrating');
INSERT OR IGNORE INTO profile_queue (tenant_id, record_id, op, at, indexed) SELECT tenant_id, id, 'backfill', 0, 0 FROM source_records;
