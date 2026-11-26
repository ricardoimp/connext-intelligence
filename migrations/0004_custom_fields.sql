-- CONNEXT INTELLIGENCE · campos personalizados
-- Criados quando uma coluna do arquivo ou da conexão não tem campo canônico equivalente (ex.: MAC, ID do dispositivo).
-- Os valores ficam em source_records.payload_json (chave x_<nome>) com a mesma tag de origem dos demais campos.
CREATE TABLE IF NOT EXISTS custom_fields (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  field_key     TEXT NOT NULL,              -- x_mac
  label         TEXT NOT NULL,              -- MAC
  data_type     TEXT NOT NULL DEFAULT 'texto',
  origin_column TEXT,                       -- nome da coluna que originou o campo
  source_id     TEXT,                       -- fonte de dados da primeira importação
  import_id     TEXT,                       -- importação que criou o campo
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, field_key)
);
