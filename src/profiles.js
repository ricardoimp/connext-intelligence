// CONNEXT INTELLIGENCE · perfis calculados no servidor
// Fila de registros -> índice de chaves fortes -> "mini tenant" com os registros ligados -> CX.rebuild ->
// cartão compacto por perfil, histórico e vínculo registro -> perfil. Roda no cron e por requisição (waitUntil).
import '../public/engine.js';
const CX = globalThis.CX;
const now = () => Date.now();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const Q = (n) => new Array(n).fill('?').join(',');
const OVERSIZED = 200, CAP = 25000;

function mergeCfg(base, saved) {
  const c = Object.assign({}, base, saved || {});
  ['dqi', 'icp', 'budget', 'workflows'].forEach(k => { c[k] = Object.assign({}, base[k], (saved || {})[k] || {}); });
  return c;
}
async function context(env, tid) {
  const [tn, srcs, decs, supp, cfs, imps] = await Promise.all([
    env.DB.prepare('SELECT id, name, salt, config_json, profiles_mode, spend FROM tenants WHERE id = ?').bind(tid).first(),
    env.DB.prepare('SELECT * FROM data_sources WHERE tenant_id = ?').bind(tid).all().then(r => r.results),
    env.DB.prepare('SELECT kind, pair_key FROM identity_decisions WHERE tenant_id = ?').bind(tid).all().then(r => r.results),
    env.DB.prepare('SELECT key_hash, channel FROM suppression_registry WHERE tenant_id = ?').bind(tid).all().then(r => r.results),
    env.DB.prepare('SELECT * FROM custom_fields WHERE tenant_id = ?').bind(tid).all().then(r => r.results),
    env.DB.prepare('SELECT id, at FROM import_jobs WHERE tenant_id = ?').bind(tid).all().then(r => r.results)
  ]);
  if (!tn) return null;
  const impAt = {}; imps.forEach(i => impAt[i.id] = i.at || 0);
  const mergeAdj = new Map(); decs.forEach(x => { if (x.kind !== 'merge') return; const [a, b] = x.pair_key.split('|'); if (!a || !b) return; (mergeAdj.get(a) || mergeAdj.set(a, []).get(a)).push(b); (mergeAdj.get(b) || mergeAdj.set(b, []).get(b)).push(a); });
  return { tn, srcs, decs, supp, cfs, impAt, mergeAdj };
}
function miniTenant(ctx, records, enrich, stages) {
  const t = CX.newTenant(ctx.tn.id, ctx.tn.name);
  t.salt = ctx.tn.salt; t.spend = ctx.tn.spend || 0; t.config = mergeCfg(CX.defaultConfig(), parse(ctx.tn.config_json, {}));
  t.sources = ctx.srcs.map(s => ({ id: s.id, name: s.name, type: s.type, origin: s.origin || '', owner: s.owner || '', legal_basis: s.legal_basis || '', purposes: parse(s.purposes_json, []), reliability: s.reliability, contract: s.contract || '' }));
  ctx.decs.forEach(x => { if (t.decisions[x.kind]) t.decisions[x.kind][x.pair_key] = { at: 0 }; });
  ctx.supp.forEach(s => { t.suppression[s.key_hash] = { type: s.channel }; });
  t.customFields = ctx.cfs.map(c => ({ k: c.field_key, label: c.label, type: c.data_type }));
  t.enrich = enrich; stages.forEach(x => { t.stages[x.entity_id] = { stage: x.stage, method: x.method, confidence: x.confidence, reason: x.reason, sig: x.sig, model: x.model, actor: x.actor, at: x.at }; });
  t.records = records; return t;
}
const recOf = x => { const p = parse(x.payload_json, {}); return { id: x.id, source_id: x.source_id, import_id: x.import_id, row: x.row_num, f: p.f || {}, flags: p.flags || null, origin: p.origin || null, observed_at: x.observed_at, type: x.entity_type, entity_id: x.entity_id }; };
const REC_COLS = 'id, source_id, import_id, row_num, entity_type, observed_at, payload_json, entity_id';
async function inQuery(env, sqlHead, tid, ids, tail) { const out = []; for (const c of chunks(ids, 90)) { const r = await env.DB.prepare(sqlHead + ' (' + Q(c.length) + ')' + (tail || '')).bind(tid, ...c).all(); out.push(...r.results); } return out; }

// índice de chaves fortes e de nomes (homônimos) de cada registro
async function indexRecords(env, tid, recs) {
  const keys = [], names = [];
  for (const r of recs) { CX.recordKeys(r).forEach(k => keys.push([k, r.id])); const hk = CX.homonymKey(r); if (hk) names.push([hk, r.id]); }
  // várias linhas por comando (limite de 100 parâmetros por consulta no D1)
  const st = [];
  for (const [tb, rows] of [['record_keys', keys], ['record_names', names]]) for (const c of chunks(rows, 33)) st.push(env.DB.prepare('INSERT OR IGNORE INTO ' + tb + ' (tenant_id, k, record_id) VALUES ' + c.map(() => '(?,?,?)').join(',')).bind(...[].concat(...c.map(x => [tid, x[0], x[1]]))));
  for (const c of chunks(st, 200)) await env.DB.batch(c);
}
// organizações do tenant inteiro (vínculo com o master no enriquecimento interno)
async function orgProfiles(env, ctx, tid) {
  if (ctx.orgs && now() - ctx.orgsAt < 60000) return ctx.orgs;
  const rows = (await env.DB.prepare("SELECT id, card_json FROM canonical_entities WHERE tenant_id = ? AND entity_type = 'organization' AND card_json IS NOT NULL ORDER BY id").bind(tid).all()).results;
  const ps = rows.map(r => CX.fromCard(r.id, JSON.parse(r.card_json))).sort((a, b) => a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0);
  ctx.orgs = ps; ctx.orgsAt = now(); return ps;
}

// processa um lote de registros da fila
async function processBatch(env, ctx, tid, queueRows) {
  const qIds = queueRows.map(q => q.record_id), ops = {}; queueRows.forEach(q => { if (q.op && q.op.startsWith('enrich:')) ops[q.record_id] = q.op.slice(7).split(','); });
  ctx.step = 'lote';
  const base = (await inQuery(env, 'SELECT ' + REC_COLS + ' FROM source_records WHERE tenant_id = ? AND id IN', tid, qIds)).map(recOf);
  const have = new Map(base.map(r => [r.id, r]));
  // índices de chaves fortes e de nomes dos registros do lote (todos os registros entram no índice antes de qualquer cálculo)
  ctx.step = 'indice';
  await indexRecords(env, tid, base);
  // componente completo: registros ligados direta ou indiretamente por chave forte não ignorada,
  // mais todos os registros dos perfis envolvidos, até não sobrar ligação nova. Com o componente inteiro
  // e a mesma contagem de blocos do cálculo completo, o resultado é idêntico ao recálculo de todo o tenant.
  ctx.step = 'componente';
  const bigKeys = new Set(), keyDone = new Set(), entDone = new Set(); let frontier = base.slice(), capped = false;
  while (frontier.length && !capped) {
    const ks = new Set(); frontier.forEach(r => CX.recordKeys(r).forEach(k => { if (!keyDone.has(k)) ks.add(k); }));
    const keys = Array.from(ks); keys.forEach(k => keyDone.add(k));
    const counts = []; for (const c of chunks(keys, 90)) counts.push(...(await env.DB.prepare("SELECT k, COUNT(*) AS c FROM record_keys WHERE tenant_id = ? AND record_id NOT IN (SELECT pair_key FROM identity_decisions WHERE tenant_id = ? AND kind = 'split') AND k IN (" + Q(c.length) + ') GROUP BY k').bind(tid, tid, ...c).all()).results);
    const good = []; counts.forEach(x => { if (x.c > OVERSIZED) bigKeys.add(x.k); else if (x.c > 1) good.push(x.k); });
    const ids = good.length ? (await inQuery(env, 'SELECT DISTINCT record_id FROM record_keys WHERE tenant_id = ? AND k IN', tid, good)).map(x => x.record_id).filter(id => !have.has(id)) : [];
    frontier.forEach(r => (ctx.mergeAdj.get(r.id) || []).forEach(o => { if (!have.has(o) && !ids.includes(o)) ids.push(o); }));  // fusões manuais também ligam componentes
    const next = [];
    if (ids.length) (await inQuery(env, 'SELECT ' + REC_COLS + ' FROM source_records WHERE tenant_id = ? AND id IN', tid, ids)).forEach(x => { if (!have.has(x.id)) { const r = recOf(x); have.set(r.id, r); next.push(r); } });
    const ents = Array.from(new Set(frontier.concat(next).map(r => r.entity_id).filter(e => e && !entDone.has(e)))); ents.forEach(e => entDone.add(e));
    if (ents.length) (await inQuery(env, 'SELECT ' + REC_COLS + ' FROM source_records WHERE tenant_id = ? AND entity_id IN', tid, ents)).forEach(x => { if (!have.has(x.id)) { const r = recOf(x); have.set(r.id, r); next.push(r); } });
    frontier = next; ctx.have = have.size; if (have.size > CAP) capped = true;
  }
  if (capped) console.error('perfis: componente acima de ' + CAP + ' registros no tenant ' + tid + '; lote ' + qIds[0]);
  const records = Array.from(have.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rids = records.map(r => r.id);
  ctx.step = 'enriquecimentos';
  const enr = (await inQuery(env, 'SELECT * FROM enrichment_results WHERE tenant_id = ? AND record_id IN', tid, rids)).map(e => ({ id: e.id, record_id: e.record_id, field: e.field, value: e.value, provider: e.provider, run: e.run_id, at: e.at, method: e.method, verification: e.verification, note: e.note, confidence: e.confidence, synthetic: !!e.synthetic, cost: e.cost }));
  const oldEnts = Array.from(new Set(records.map(r => r.entity_id).filter(Boolean)));
  const stg = oldEnts.length ? await inQuery(env, 'SELECT * FROM lead_stages WHERE tenant_id = ? AND entity_id IN', tid, oldEnts) : [];
  const t = miniTenant(ctx, records, enr, stg);
  ctx.step = 'organizacoes';
  t.bigKeys = bigKeys; t.orgProfiles = await orgProfiles(env, ctx, tid);
  ctx.step = 'calculo';
  CX.rebuild(t);
  // enriquecimento pedido para registros do lote
  // perfis agrupados pelo mesmo pedido de provedores: uma execução por pedido, como no enriquecimento manual
  const groups = new Map(); for (const rid in ops) { const eid = t.derived.recToEnt[rid]; if (!eid) continue; const k = ops[rid].join(','); if (!groups.has(k)) groups.set(k, new Set()); groups.get(k).add(eid); }
  const newEnrich = [], runs = [], newCache = [];
  if (groups.size) {
    // consultas já feitas a cada provedor para cada perfil não se repetem (mesma regra de custo do navegador)
    const ckeys = []; groups.forEach((ids, k) => k.split(',').forEach(pv => ids.forEach(id => ckeys.push(pv + '|' + t.derived.byId[id].anchor))));
    (await inQuery(env, 'SELECT cache_key FROM enrichment_cache WHERE tenant_id = ? AND cache_key IN', tid, ckeys)).forEach(x => t.cache[x.cache_key] = 1);
    const had = new Set(Object.keys(t.cache)), spend0 = t.spend; t.idp = 's' + now().toString(36) + Math.random().toString(36).slice(2, 6) + '_';
    for (const [k, ids] of groups) { const before = t.enrich.length; runs.push(CX.runEnrichment(t, Array.from(ids), k.split(','), { actor: 'servidor', trigger: 'Enriquecimento em lote' })); newEnrich.push(...t.enrich.slice(before)); }
    Object.keys(t.cache).forEach(c => { if (!had.has(c)) newCache.push(c); });
    newEnrich.forEach((e, i) => { e.id = 'er_' + t.idp + i.toString(36); });
    t.spendDelta = Math.round((t.spend - spend0) * 100) / 100;
  }
  const d = t.derived, at = now(), stmts = [];
  newCache.forEach(c => stmts.push(env.DB.prepare('INSERT OR IGNORE INTO enrichment_cache (tenant_id, cache_key) VALUES (?,?)').bind(tid, c)));
  runs.forEach(r => stmts.push(env.DB.prepare('INSERT OR REPLACE INTO enrichment_requests (tenant_id, id, at, actor, state, cost, filled, data_json) VALUES (?,?,?,?,?,?,?,?)').bind(tid, r.id, r.at, r.actor, r.state, r.cost, r.filled, JSON.stringify(Object.assign({}, r, { changes: {} })))));
  if (t.spendDelta) stmts.push(env.DB.prepare('UPDATE tenants SET spend = spend + ? WHERE id = ?').bind(t.spendDelta, tid));
  newEnrich.forEach(e => stmts.push(env.DB.prepare('INSERT OR IGNORE INTO enrichment_results (tenant_id, id, record_id, field, value, provider, run_id, at, method, verification, note, confidence, synthetic, cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(tid, e.id, e.record_id, e.field, String(e.value), e.provider, e.run || null, e.at, e.method || null, e.verification || null, e.note || null, e.confidence || null, e.synthetic ? 1 : 0, e.cost || 0)));
  // perfis atuais
  ctx.step = 'assinaturas';
  const prevSig = {}; if (d.profiles.length) (await inQuery(env, 'SELECT id, sig FROM canonical_entities WHERE tenant_id = ? AND id IN', tid, d.profiles.map(p => p.id))).forEach(x => prevSig[x.id] = x.sig);
  const newIds = new Set();
  for (const p of d.profiles) {
    newIds.add(p.id);
    const ims = Array.from(new Set(p.record_ids.map(id => have.get(id).import_id).filter(Boolean)));
    let fi = null; ims.forEach(i => { if (fi == null || (ctx.impAt[i] || 0) < (ctx.impAt[fi] || 0)) fi = i; });
    const card = CX.card(p, { fi, ims: ims.slice(0, 20) }), cj = JSON.stringify(card), sig = CX.hash(cj);
    // histórico de versões só quando o conteúdo do perfil muda (valores, fontes, registros, decisões); a variação
    // diária de atualidade e dos indicadores derivados dela atualiza o perfil, mas não cria versão nova
    const vc = Object.assign({}, card, { s: undefined, l: undefined, u: undefined, f: Object.fromEntries(Object.entries(card.f).map(([k, a]) => [k, [a[0], a[3], a[4], a[2] & 5]])) }), vsig = CX.hash(JSON.stringify(vc));
    if (prevSig[p.id] !== sig) {
      stmts.push(env.DB.prepare('INSERT INTO canonical_entities (tenant_id, id, entity_type, name, level, dqi, completeness, confidence, freshness, qualification, contactability, record_count, org_id, suppressed, elig_json, sources_json, golden_json, sig, updated_at, card_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id, id) DO UPDATE SET entity_type = excluded.entity_type, name = excluded.name, level = excluded.level, dqi = excluded.dqi, completeness = excluded.completeness, confidence = excluded.confidence, freshness = excluded.freshness, qualification = excluded.qualification, contactability = excluded.contactability, record_count = excluded.record_count, org_id = excluded.org_id, suppressed = excluded.suppressed, elig_json = excluded.elig_json, sources_json = excluded.sources_json, golden_json = excluded.golden_json, sig = excluded.sig, updated_at = excluded.updated_at, card_json = excluded.card_json')
        .bind(tid, p.id, p.type, String(p.name || '').slice(0, 200), p.level, p.scores.dqi, p.scores.completeness, p.scores.confidence, p.scores.freshness, p.scores.qualification, p.scores.contactability, p.record_ids.length, p.org_id || null, p.suppressed ? 1 : 0, JSON.stringify(p.elig || {}), JSON.stringify(p.sources), '{}', sig, at, cj));
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO golden_profile_versions (tenant_id, entity_id, sig, golden_json, scores_json, at) VALUES (?,?,?,?,?,?)').bind(tid, p.id, vsig, cj, JSON.stringify(p.scores), at));
    }
    for (const rid of p.record_ids) { const r = have.get(rid); if (r.entity_id !== p.id) stmts.push(env.DB.prepare('UPDATE source_records SET entity_id = ? WHERE tenant_id = ? AND id = ?').bind(p.id, tid, rid)); }
  }
  // perfis que deixaram de existir (fundidos em outro)
  for (const old of oldEnts) if (!newIds.has(old)) {
    stmts.push(env.DB.prepare('DELETE FROM canonical_entities WHERE tenant_id = ? AND id = ?').bind(tid, old));
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO entity_tombstones (tenant_id, id, at) VALUES (?,?,?)').bind(tid, old, at));
  }
  // pares para revisão humana
  // candidatos por chave forte deste componente (os de mesmo nome vêm do passo global)
  const entSet = Array.from(new Set(oldEnts.concat(Array.from(newIds))));
  for (const c of chunks(entSet, 45)) stmts.push(env.DB.prepare("DELETE FROM identity_match_candidates WHERE tenant_id = ? AND kind = 'chave' AND (ent_a IN (" + Q(c.length) + ") OR ent_b IN (" + Q(c.length) + "))").bind(tid, ...c, ...c));
  (d.keyCands || []).forEach(c => { const ea = d.recToEnt[c.a], eb = d.recToEnt[c.b]; stmts.push(env.DB.prepare("INSERT INTO identity_match_candidates (tenant_id, pair_key, score, reasons_json, status, updated_at, ent_a, ent_b, kind) VALUES (?,?,?,?,'pendente',?,?,?,'chave') ON CONFLICT (tenant_id, pair_key) DO UPDATE SET score = excluded.score, reasons_json = excluded.reasons_json, updated_at = excluded.updated_at, ent_a = excluded.ent_a, ent_b = excluded.ent_b, kind = 'chave'").bind(tid, c.key, c.score, JSON.stringify(c.reasons), at, ea < eb ? ea : eb, ea < eb ? eb : ea)); });
  if (newIds.size || oldEnts.length) stmts.push(env.DB.prepare('INSERT INTO tenant_stats (tenant_id, dirty, cands_dirty, at) VALUES (?, 1, 1, ?) ON CONFLICT (tenant_id) DO UPDATE SET dirty = 1, cands_dirty = 1').bind(tid, at));
  qIds.forEach(id => stmts.push(env.DB.prepare('DELETE FROM profile_queue WHERE tenant_id = ? AND record_id = ?').bind(tid, id)));
  ctx.step = 'gravacao';
  for (const c of chunks(stmts, 500)) await env.DB.batch(c);
  return { records: qIds.length, touched: d.profiles.length, removed: oldEnts.filter(x => !newIds.has(x)).length };
}

// processa a fila de um tenant por até budgetMs; um processador por vez (trava com prazo)
export async function processQueue(env, tid, budgetMs, withCands) {
  const t0 = now(), lock = t0 + budgetMs + 15000;
  const got = await env.DB.prepare('UPDATE tenants SET profile_lock_until = ? WHERE id = ? AND (profile_lock_until IS NULL OR profile_lock_until < ?) RETURNING id').bind(lock, tid, t0).first();
  if (!got) return { busy: true };
  let done = 0, touched = 0, batches = 0;
  try {
    const ctx = await context(env, tid); if (!ctx) return { done: 0 };
    // fase 1: todo registro da fila entra nos índices antes de qualquer cálculo, para a contagem dos blocos
    // ser a mesma do cálculo completo. Quando um bloco passa de 200 registros, os perfis que o usavam são recalculados.
    let pendingIdx = true;
    while (now() - t0 < budgetMs) {
      const qi = (await env.DB.prepare('SELECT record_id FROM profile_queue WHERE tenant_id = ? AND indexed = 0 LIMIT 3000').bind(tid).all()).results.map(x => x.record_id);
      if (!qi.length) { pendingIdx = false; break; }
      const recs = (await inQuery(env, 'SELECT ' + REC_COLS + ' FROM source_records WHERE tenant_id = ? AND id IN', tid, qi)).map(recOf);
      const touched = Array.from(new Set([].concat(...recs.map(r => CX.recordKeys(r)))));
      // na carga inicial ainda não existe perfil calculado, então não há bloco "que passou de 200" a recalcular
      const fresh = ctx.tn.profiles_mode === 'migrating' && !ctx.anyCard && !(ctx.anyCard = !!(await env.DB.prepare('SELECT 1 AS x FROM canonical_entities WHERE tenant_id = ? AND card_json IS NOT NULL LIMIT 1').bind(tid).first()));
      const before = fresh ? new Map() : await keyCounts(env, tid, touched);
      await indexRecords(env, tid, recs);
      const after = fresh ? new Map() : await keyCounts(env, tid, touched), crossed = touched.filter(k => (before.get(k) || 0) <= OVERSIZED && (after.get(k) || 0) > OVERSIZED);
      const st = crossed.map(k => env.DB.prepare('INSERT INTO profile_queue (tenant_id, record_id, op, at, indexed) SELECT tenant_id, record_id, NULL, ?, 1 FROM record_keys WHERE tenant_id = ? AND k = ? ON CONFLICT (tenant_id, record_id) DO NOTHING').bind(now(), tid, k));
      for (const c of chunks(qi, 90)) st.push(env.DB.prepare('UPDATE profile_queue SET indexed = 1 WHERE tenant_id = ? AND record_id IN (' + Q(c.length) + ')').bind(tid, ...c));
      for (const c of chunks(st, 400)) await env.DB.batch(c);
    }
    while (!pendingIdx && now() - t0 < budgetMs) {
      const rows = (await env.DB.prepare('SELECT record_id, op FROM profile_queue WHERE tenant_id = ? ORDER BY record_id LIMIT 400').bind(tid).all()).results;
      if (!rows.length) break;
      let r; try { r = await processBatch(env, ctx, tid, rows); } catch (e) { e.message = 'lote de ' + rows.length + ' a partir de ' + rows[0].record_id + ', passo ' + ctx.step + ' (' + (ctx.have || 0) + ' registros carregados): ' + e.message; throw e; }
      done += r.records; touched += r.touched; batches++;
    }
    if (done) await env.DB.prepare('INSERT INTO tenant_stats (tenant_id, dirty, at) VALUES (?, 1, ?) ON CONFLICT (tenant_id) DO UPDATE SET dirty = 1').bind(tid, now()).run();
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM profile_queue WHERE tenant_id = ?').bind(tid).first();
    if (!left.n && withCands) await refreshCandidates(env, ctx, tid);  // passo global: só no agendador
    if (!left.n && ctx.tn.profiles_mode === 'migrating') {
      // migração concluída: remove perfis antigos sem registros e passa a ler os cartões do servidor
      await env.DB.prepare('DELETE FROM canonical_entities WHERE tenant_id = ? AND (card_json IS NULL OR id NOT IN (SELECT DISTINCT entity_id FROM source_records WHERE tenant_id = ? AND entity_id IS NOT NULL))').bind(tid, tid).run();
      await env.DB.prepare("UPDATE tenants SET profiles_mode = 'server' WHERE id = ?").bind(tid).run();
      await refreshStats(env, tid, true);
    }
    return { done, touched, batches, left: left.n, ms: now() - t0 };
  } finally {
    await env.DB.prepare('UPDATE tenants SET profile_lock_until = NULL WHERE id = ?').bind(tid).run();
  }
}

async function keyCounts(env, tid, keys) {
  const m = new Map();
  for (const c of chunks(keys, 90)) (await env.DB.prepare("SELECT k, COUNT(*) AS c FROM record_keys WHERE tenant_id = ? AND record_id NOT IN (SELECT pair_key FROM identity_decisions WHERE tenant_id = ? AND kind = 'split') AND k IN (" + Q(c.length) + ') GROUP BY k').bind(tid, tid, ...c).all()).results.forEach(x => m.set(x.k, x.c));
  return m;
}

// passo global: candidatos de mesmo nome (cruzam perfis sem chave forte em comum), com a mesma regra do cálculo completo
export async function refreshCandidates(env, ctx, tid, force) {
  const st = await env.DB.prepare('SELECT cands_dirty FROM tenant_stats WHERE tenant_id = ?').bind(tid).first();
  if (!force && st && !st.cands_dirty) return null;
  const split = new Set(ctx.decs.filter(x => x.kind === 'split').map(x => x.pair_key)), dec = new Set(ctx.decs.filter(x => x.kind === 'merge' || x.kind === 'reject').map(x => x.pair_key));
  // blocos de 2 a 40 registros (sem os separados manualmente), como no motor
  const names = (await env.DB.prepare('SELECT k, record_id FROM record_names WHERE tenant_id = ? AND k IN (SELECT k FROM record_names WHERE tenant_id = ? GROUP BY k HAVING COUNT(*) >= 2) ORDER BY k, record_id').bind(tid, tid).all()).results;
  const blocks = new Map(); names.forEach(x => { if (split.has(x.record_id)) return; let b = blocks.get(x.k); if (!b) blocks.set(x.k, b = []); b.push(x.record_id); });
  const useful = []; blocks.forEach((b, k) => { if (b.length >= 2 && b.length <= 40) useful.push(b); });
  const need = Array.from(new Set([].concat(...useful))), recs = new Map();
  for (const c of chunks(need, 90)) (await env.DB.prepare('SELECT ' + REC_COLS + ' FROM source_records WHERE tenant_id = ? AND id IN (' + Q(c.length) + ')').bind(tid, ...c).all()).results.forEach(x => recs.set(x.id, recOf(x)));
  const out = new Map();
  for (const b of useful) {
    const roots = new Map(); for (const id of b) { const r = recs.get(id); if (!r || !r.entity_id) continue; if (!roots.has(r.entity_id)) roots.set(r.entity_id, r); }
    const reps = Array.from(roots.values()).slice(0, 12);
    for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) {
      const A = reps[i], B = reps[j], key = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id; if (dec.has(key)) continue;
      const h = CX.homonymPair(A, B); if (!h) continue;
      const ea = A.entity_id < B.entity_id ? A.entity_id : B.entity_id, eb = A.entity_id < B.entity_id ? B.entity_id : A.entity_id, ck = ea + '|' + eb, prev = out.get(ck);
      if (!prev || prev.score < h.score) out.set(ck, { key, ea, eb, score: h.score, reasons: h.reasons });
    }
  }
  const at = now(), stmts = [env.DB.prepare("DELETE FROM identity_match_candidates WHERE tenant_id = ? AND kind = 'nome'").bind(tid)];
  out.forEach(c => stmts.push(env.DB.prepare("INSERT INTO identity_match_candidates (tenant_id, pair_key, score, reasons_json, status, updated_at, ent_a, ent_b, kind) VALUES (?,?,?,?,'pendente',?,?,?,'nome') ON CONFLICT (tenant_id, pair_key) DO NOTHING").bind(tid, c.key, c.score, JSON.stringify(c.reasons), at, c.ea, c.eb)));
  stmts.push(env.DB.prepare('INSERT INTO tenant_stats (tenant_id, dirty, cands_dirty, at) VALUES (?, 1, 0, ?) ON CONFLICT (tenant_id) DO UPDATE SET cands_dirty = 0').bind(tid, at));
  for (const c of chunks(stmts, 400)) await env.DB.batch(c);
  return out.size;
}

// indicadores por fonte e por semana, calculados no banco (a interface não carrega mais os registros)
export async function refreshStats(env, tid, force) {
  const row = await env.DB.prepare('SELECT dirty, at FROM tenant_stats WHERE tenant_id = ?').bind(tid).first();
  if (!force && row && (!row.dirty || now() - (row.at || 0) < 30000)) return null;
  // durante a carga inicial os indicadores esperam a fila terminar (evita disputar memória com o cálculo)
  if (!force) { const tn = await env.DB.prepare('SELECT profiles_mode FROM tenants WHERE id = ?').bind(tid).first(); if (tn && tn.profiles_mode === 'migrating') return null; }
  // leitura em páginas pequenas: cada página traz só fonte, data e chaves de campo válidas/inválidas
  const wk = new Map(), bs = new Map(), fl = new Map(); let after = '', total = 0;
  while (true) {
    const rows = (await env.DB.prepare("SELECT id, source_id AS s, observed_at AS o, (SELECT group_concat(key || '=' || COALESCE(json_extract(value, '$[0].valid'), 0), ',') FROM json_each(json_extract(payload_json, '$.f'))) AS f FROM source_records WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT 4000").bind(tid, after).all()).results;
    if (!rows.length) break;
    for (const r of rows) {
      total++; const w = Math.floor((r.o || 0) / 604800000), kw = r.s + '|' + w; wk.set(kw, (wk.get(kw) || 0) + 1); bs.set(r.s, (bs.get(r.s) || 0) + 1);
      if (r.f) for (const x of r.f.split(',')) { const e = x.lastIndexOf('='), k = r.s + '|' + x.slice(0, e), a = fl.get(k) || [0, 0]; a[0]++; if (x.slice(e + 1) === '1') a[1]++; fl.set(k, a); }
    }
    after = rows[rows.length - 1].id; if (rows.length < 4000) break;
  }
  const big = await env.DB.prepare("SELECT COUNT(*) AS n FROM (SELECT k FROM record_keys WHERE tenant_id = ? AND record_id NOT IN (SELECT pair_key FROM identity_decisions WHERE tenant_id = ? AND kind = 'split') GROUP BY k HAVING COUNT(*) > ?)").bind(tid, tid, OVERSIZED).first();
  const weekly = [], bySrc = [], fields = [];
  wk.forEach((n, k) => { const i = k.lastIndexOf('|'); weekly.push({ s: k.slice(0, i), w: +k.slice(i + 1), n }); });
  bs.forEach((n, s) => bySrc.push({ s, n }));
  fl.forEach((a, k) => { const i = k.indexOf('|'); fields.push({ s: k.slice(0, i), k: k.slice(i + 1), n: a[0], ok: a[1] }); });
  const stats = { weekly, bySrc, fields, records: total, oversized: big ? big.n : 0, at: now() };
  await env.DB.prepare('INSERT INTO tenant_stats (tenant_id, stats_json, dirty, at) VALUES (?,?,0,?) ON CONFLICT (tenant_id) DO UPDATE SET stats_json = excluded.stats_json, dirty = 0, at = excluded.at').bind(tid, JSON.stringify(stats), now()).run();
  return stats;
}

export async function enqueue(env, tid, recordIds, op) {
  const st = recordIds.map(id => env.DB.prepare('INSERT INTO profile_queue (tenant_id, record_id, op, at) VALUES (?,?,?,?) ON CONFLICT (tenant_id, record_id) DO UPDATE SET op = COALESCE(excluded.op, profile_queue.op)').bind(tid, id, op || null, now()));
  for (const c of chunks(st, 500)) await env.DB.batch(c);
}
