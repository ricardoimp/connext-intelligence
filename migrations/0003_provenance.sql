-- CONNEXT INTELLIGENCE · comprovante de origem de cada importação
-- Capturado pelo servidor no recebimento do arquivo, antes de qualquer gravação de registros.
ALTER TABLE import_jobs ADD COLUMN provenance_json TEXT;   -- IP, local, provedor, navegador, usuário, data, hora, carimbo de tempo
ALTER TABLE import_jobs ADD COLUMN raw_sha256 TEXT;        -- impressão digital do arquivo original calculada no servidor
ALTER TABLE import_jobs ADD COLUMN ai_analysis_id TEXT;    -- leitura obrigatória do Claude que antecedeu a gravação
ALTER TABLE import_jobs ADD COLUMN decision_json TEXT;     -- decisão da pessoa sobre a recomendação da IA
