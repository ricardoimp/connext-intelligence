-- CONNEXT INTELLIGENCE · custo da IA em reais
-- Câmbio dólar/real (PTAX de venda do Banco Central) guardado por dia; cada chamada registra o câmbio usado.
CREATE TABLE IF NOT EXISTS fx_rates (
  pair     TEXT NOT NULL,      -- USDBRL
  day      TEXT NOT NULL,      -- dia da consulta (horário de Brasília), AAAA-MM-DD
  rate     REAL NOT NULL,      -- reais por dólar
  source   TEXT,               -- PTAX Banco Central ou cotação comercial
  ref_date TEXT,               -- data e hora da cotação informada pela fonte
  at       INTEGER,
  PRIMARY KEY (pair, day)
);
ALTER TABLE agent_executions ADD COLUMN fx_rate REAL;
ALTER TABLE agent_executions ADD COLUMN cost_brl REAL;
