/* CONNEXT INTELLIGENCE · importação no servidor (conectores e webhook)
   Usa o mesmo motor da interface para mapear, normalizar e validar; grava registros e a importação no D1.
   Os perfis mestres são recalculados quando a plataforma é aberta (motor da interface) ou no próximo ciclo. */
const CX = globalThis.CX;
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 6);

export async function serverImport(env, tid, conn, data, label, actor, extra) {
  const tenant = await env.DB.prepare('SELECT salt, seq FROM tenants WHERE id = ?').bind(tid).first();
  const s = await env.DB.prepare('SELECT * FROM data_sources WHERE tenant_id = ? AND id = ?').bind(tid, conn.source_id).first();
  if (!s) throw Object.assign(new Error('A fonte vinculada ao conector não existe mais.'), { status: 409 });
  const src = { id: s.id, name: s.name, type: s.type, origin: s.origin, owner: s.owner, legal_basis: s.legal_basis, purposes: JSON.parse(s.purposes_json || '[]'), reliability: s.reliability, contract: s.contract, created_at: s.created_at };
  const miss = CX.sourcePolicy(src);
  if (miss.length) throw Object.assign(new Error('Importação bloqueada pela política: falta ' + miss.join(', ') + ' na fonte.'), { status: 409 });
  if (!data.rows.length) return { skipped: true, reason: 'nenhum registro novo' };
  const fileHash = CX.hash(JSON.stringify([data.headers, data.rows]));
  const dup = await env.DB.prepare('SELECT id FROM import_jobs WHERE tenant_id = ? AND source_id = ? AND file_hash = ? AND status = ?').bind(tid, src.id, fileHash, 'concluído').first();
  if (dup) return { skipped: true, reason: 'conteúdo idêntico já importado em ' + dup.id };

  // mapeamento: aprovado pelo usuário quando existir, senão o sugerido pelas regras
  let byHeader = null; try { byHeader = conn.mapping_json ? JSON.parse(conn.mapping_json) : null; } catch (e) { byHeader = null; }
  const sug = CX.suggestMapping(null, data.headers, data.rows), mapping = {}, headerMap = {};
  // com mapeamento aprovado, só entra o que foi aprovado; colunas novas na origem ficam fora e são avisadas
  const novas = [];
  sug.cols.forEach(c => { const f = byHeader ? (c.header in byHeader ? byHeader[c.header] : (novas.push(c.header), null)) : (c.confidence >= 0.6 ? c.field : null); if (f && !c.sensitive) mapping[c.col] = f; headerMap[c.header] = f || null; });
  if (!Object.keys(mapping).length) throw Object.assign(new Error('Nenhuma coluna mapeada para o modelo canônico. Revise o mapeamento do conector.'), { status: 422 });

  const t = CX.newTenant(tid, tid); t.salt = tenant.salt; t.seq = tenant.seq || 0; t.idp = 'srv' + rid() + '_'; t.sources = [src];
  const b = CX.beginImport(t, { sourceId: src.id, fileName: label, fileHash, format: conn.type.toUpperCase(), encoding: 'UTF-8', bytes: JSON.stringify(data.rows).length, at: Date.now(), actor, mapping, headerMap, sig: sug.sig, parseErrors: data.errors || [], total: data.rows.length });
  const job = b.job, now = Date.now(), d = new Date(now), brt = new Date(now - 3 * 3600e3).toISOString();
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([data.headers, data.rows])))), x => x.toString(16).padStart(2, '0')).join('');
  const prov = Object.assign({ usuario: actor, conexao_id: conn.id, conexao_nome: conn.name, data: brt.slice(0, 10).split('-').reverse().join('/'), hora: brt.slice(11, 19) + ' (horário de Brasília)', timestamp_iso_utc: d.toISOString(), timestamp_epoch_ms: now, registros_recebidos: data.rows.length, sha256: sha, fonte_id: src.id, fonte_nome: src.name, proprietario: src.owner || null, fonte_origem: src.origin, base_legal: src.legal_basis }, extra || {});
  job.origin = { source_id: src.id, source_name: src.name, proprietario: src.owner || null, import_id: job.id, file: label, by: actor, channel: (extra && extra.canal) || conn.type, ip: (extra && extra.ip) || null, at: now };
  CX.processChunk(t, job, data.rows, 0, data.rows.length); job.status = 'concluído';
  const stmts = [];
  stmts.push(env.DB.prepare('INSERT OR REPLACE INTO import_jobs (tenant_id, id, source_id, file_name, file_hash, format, encoding, bytes, version, status, total, received, normalized, validated, row_errors, raw_key, actor, at, provenance_json, raw_sha256, ai_analysis_id, data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(tid, job.id, src.id, label, fileHash, job.format, job.encoding, job.bytes, 1, job.status, job.total, job.st.received, job.st.normalized, job.st.validated, job.rowErrors.length, null, actor, job.at, JSON.stringify(prov), sha, conn.mapping_json ? 'mapeamento_aprovado:' + conn.id : 'regras', JSON.stringify({ mapping, st: job.st, ms: job.ms, parseErrors: job.parseErrors.slice(0, 200), rowErrors: job.rowErrors.slice(0, 200), cursor: job.cursor, connector: conn.id })));
  for (const r of t.records) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO source_records (tenant_id, id, source_id, import_id, row_num, entity_type, observed_at, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(tid, r.id, r.source_id, r.import_id, r.row, r.type, r.observed_at, JSON.stringify({ f: r.f, flags: r.flags, origin: r.origin }), now));
  // campos personalizados mapeados no conector: cria a definição na base se ainda não existir
  sug.cols.forEach(c => { const k = mapping[c.col]; if (CX.isCustom(k)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO custom_fields (tenant_id, field_key, label, data_type, origin_column, source_id, import_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(tid, k, String(c.header).slice(0, 60), CX.inferType(data.rows.slice(0, 200).map(r => r[c.col])), c.header, src.id, job.id, actor, now)); });
  stmts.push(env.DB.prepare('UPDATE tenants SET seq = MAX(seq, ?), updated_at = ? WHERE id = ?').bind(t.seq, now, tid));
  stmts.push(env.DB.prepare('INSERT INTO workflow_executions (tenant_id, id, kind, trigger, ref, at, state, attempts, ms, cost, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(tid, 'wf_' + t.idp + '1', 'Importação por conector', conn.type === 'webhook' ? 'Novo registro recebido' : 'Sincronização agendada', job.id, now, 'concluído', 1, job.ms.normalize, 0, job.st.normalized + ' registros de ' + conn.name));
  stmts.push(env.DB.prepare('INSERT INTO audit_events (tenant_id, id, at, actor, action, detail, ref) VALUES (?,?,?,?,?,?,?)').bind(tid, 'srv_' + t.idp + 'imp', now, actor, 'importacao_concluida', job.id + ' · ' + job.st.normalized + ' registros · ' + conn.name, conn.id));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return { import_id: job.id, records: job.st.normalized, row_errors: job.rowErrors.length, colunas_novas_fora_do_mapeamento: novas };
}
