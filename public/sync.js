/* CONNEXT INTELLIGENCE · persistência no servidor (D1 + R2 via API do Worker)
   Estratégia: o motor continua reconstruindo os perfis no navegador a partir de registros, decisões e evidências.
   Esta camada carrega o estado do tenant do banco e envia apenas o que mudou (diferença por tabela). */
(function (root) {
'use strict';
const CX = root.CX;
const API = '/api';
const S = { session: null };
const j = v => JSON.stringify(v);
const parse = (v, d) => { if (v == null || v === '') return d; try { return JSON.parse(v); } catch (e) { return d; } };
const uid = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);

async function call(method, path, body, raw) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (raw) { opt.body = raw; opt.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = j(body); opt.headers['content-type'] = 'application/json'; }
  const r = await fetch(API + path, opt);
  let data = null; try { data = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (!r.ok || !data || data.ok === false) { const e = new Error((data && data.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return data;
}

/* ---------- linhas por tabela, a partir do estado do motor ---------- */
const MUTABLE = { data_sources: 1, import_jobs: 1, mapping_templates: 1, identity_decisions: 1, identity_match_candidates: 1, canonical_entities: 1, scoring_models: 1, enrichment_requests: 1, workflow_executions: 1, segments: 1, suppression_registry: 1 };
const ORDER = ['data_sources', 'import_jobs', 'source_records', 'mapping_templates', 'identity_decisions', 'enrichment_results', 'enrichment_requests', 'enrichment_cache', 'suppression_registry', 'erasure_requests', 'segments', 'scoring_models', 'data_quality_assessments', 'workflow_executions', 'identity_match_candidates', 'canonical_entities', 'golden_profile_versions', 'audit_events'];
const PK = { identity_decisions: r => r.kind + '|' + r.pair_key, golden_profile_versions: r => r.entity_id + '|' + r.sig, mapping_templates: r => r.sig, scoring_models: r => String(r.version), enrichment_cache: r => r.cache_key, suppression_registry: r => r.key_hash, identity_match_candidates: r => r.pair_key };
const keyOf = (tb, r) => PK[tb] ? PK[tb](r) : r.id;
const delKey = (tb, k) => tb === 'identity_decisions' ? [k.slice(k.indexOf('|') + 1), k.slice(0, k.indexOf('|'))] : tb === 'golden_profile_versions' ? k.split('|') : tb === 'scoring_models' ? +k : k;

function golden(p) {
  const g = {};
  for (const k in p.fields) { const f = p.fields[k]; g[k] = { value: f.value, source_id: f.source_id, observed_at: f.observed_at, method: f.method, verification: f.verification, confidence: f.confidence, justification: f.justification, conflict: !!f.conflict, stale: !!f.stale, synthetic: !!f.synthetic, permitted: f.permitted || [] }; }
  return g;
}
function tables(t, prev) {
  const T = {};
  T.data_sources = t.sources.map(s => ({ id: s.id, name: s.name || s.id, type: s.type, origin: s.origin, owner: s.owner, legal_basis: s.legal_basis, purposes_json: s.purposes || [], reliability: s.reliability, contract: s.contract, created_at: s.created_at, updated_at: s.updated_at || s.created_at }));
  T.import_jobs = t.imports.filter(i => i.status !== 'processando').map(i => ({ id: i.id, source_id: i.sourceId, file_name: i.fileName, file_hash: i.fileHash, format: i.format, encoding: i.encoding, bytes: i.bytes, version: i.version, status: i.status, total: i.total, received: i.st.received, normalized: i.st.normalized, validated: i.st.validated, row_errors: i.rowErrors.length + i.parseErrors.length, raw_key: i.raw_key || null, actor: i.actor, at: i.at, data_json: { mapping: i.mapping, st: i.st, ms: i.ms, parseErrors: i.parseErrors.slice(0, 200), rowErrors: i.rowErrors.slice(0, 200), cursor: i.cursor } }));
  T.source_records = t.records.map(r => ({ id: r.id, source_id: r.source_id, import_id: r.import_id, row_num: r.row, entity_type: r.type, observed_at: r.observed_at, payload_json: { f: r.f, flags: r.flags } }));
  T.mapping_templates = Object.keys(t.mappings).map(sig => { const m = t.mappings[sig]; return { sig, file_name: m.fileName, map_json: m.map, used: m.used, at: m.at }; });
  T.identity_decisions = [];
  ['merge', 'reject', 'split'].forEach(kind => { for (const k in t.decisions[kind]) T.identity_decisions.push({ pair_key: k, kind, actor: t.decisions[kind][k].actor, at: t.decisions[kind][k].at }); });
  T.enrichment_results = t.enrich.map(e => { if (!e.id) e.id = 'er_' + uid(); return { id: e.id, record_id: e.record_id, field: e.field, value: e.value, provider: e.provider, run_id: e.run, at: e.at, method: e.method, verification: e.verification, note: e.note, confidence: e.confidence, synthetic: e.synthetic ? 1 : 0, cost: e.cost }; });
  T.enrichment_requests = t.enrichRuns.map(r => ({ id: r.id, at: r.at, actor: r.actor, state: r.state, cost: r.cost, filled: r.filled, data_json: r }));
  T.enrichment_cache = Object.keys(t.cache).map(k => ({ cache_key: k }));
  T.suppression_registry = Object.keys(t.suppression).map(k => ({ key_hash: k, channel: t.suppression[k].type, reason: t.suppression[k].reason, at: t.suppression[k].at }));
  T.erasure_requests = t.erased.map(e => { if (!e.id) e.id = 'el_' + uid(); return { id: e.id, ref_hash: e.ref, records: e.records, at: e.at, actor: e.actor }; });
  T.segments = t.segments.map(s => { if (!s.id) s.id = 'seg_' + uid(); return { id: s.id, name: s.name, purpose: s.purpose, definition_json: { op: s.op, rules: s.rules }, at: s.at || Date.now() }; });
  T.scoring_models = t.modelVersions.map(m => ({ version: m.version, at: m.at, dqi_json: m.dqi, icp_json: m.icp, avg_dqi: m.avg }));
  T.data_quality_assessments = t.snapshots.map(s => { if (!s.id) s.id = 'dq_' + uid(); return { id: s.id, at: s.at, import_id: s.import_id, records: s.records, entities: s.entities, dqi: s.dqi, completeness: s.completeness, confidence: s.confidence }; });
  T.workflow_executions = t.executions.map(e => ({ id: e.id, kind: e.kind, trigger: e.trigger, ref: e.ref, at: e.at, state: e.state, attempts: e.attempts, ms: e.ms, cost: e.cost, detail: e.detail }));
  T.audit_events = t.audit.map(a => { if (!a.id) a.id = 'au_' + uid(); return { id: a.id, at: a.at, actor: a.actor, action: a.action, detail: a.detail, ref: a.ref }; });
  const d = t.derived;
  if (d && (!prev || prev.derived !== d)) {
    T.identity_match_candidates = d.candidates.map(c => ({ pair_key: c.key, score: Math.round(c.score * 1000) / 1000, reasons_json: c.reasons, status: 'pendente', updated_at: d.at }));
    T.canonical_entities = []; T.golden_profile_versions = [];
    for (const p of d.profiles) {
      const g = golden(p), sig = CX.hash(j([p.type, p.level, p.scores, p.record_ids, g]));
      T.canonical_entities.push({ id: p.id, entity_type: p.type, name: p.name, level: p.level, dqi: p.scores.dqi, completeness: p.scores.completeness, confidence: p.scores.confidence, freshness: p.scores.freshness, qualification: p.scores.qualification, contactability: p.scores.contactability, record_count: p.record_ids.length, org_id: p.org_id || null, suppressed: p.suppressed ? 1 : 0, elig_json: p.elig, sources_json: p.sources, golden_json: g, sig, updated_at: p.updated_at, _recs: p.record_ids });
      T.golden_profile_versions.push({ entity_id: p.id, sig, golden_json: g, scores_json: p.scores, at: d.at });
    }
  }
  return T;
}

/* ---------- diferença e envio ---------- */
function snapshot(t, T) {
  const st = t._sync || (t._sync = { maps: {}, derived: null, entRecs: new Map(), cfg: null });
  for (const tb in T) {
    const m = st.maps[tb] = st.maps[tb] || new Map();
    if (tb === 'golden_profile_versions') { for (const r of T[tb]) m.set(keyOf(tb, r), '1'); continue; }
    m.clear(); for (const r of T[tb]) m.set(keyOf(tb, r), MUTABLE[tb] ? CX.hash(j(r)) : '1');
    if (tb === 'canonical_entities') { st.entRecs.clear(); for (const r of T[tb]) st.entRecs.set(r.id, r._recs); }
  }
  if (t.derived) st.derived = t.derived;
  st.cfg = CX.hash(j([t.config, t.spend, t.seq, t.cacheHits]));
}
function diff(t) {
  const st = t._sync, T = tables(t, st), ops = [], next = {};
  for (const tb of ORDER) {
    if (!T[tb]) continue;
    const old = st.maps[tb] || new Map(), cur = new Map(), up = [];
    for (const r of T[tb]) { const k = keyOf(tb, r), h = MUTABLE[tb] ? CX.hash(j(r)) : '1'; cur.set(k, h); if (old.get(k) !== h) { const c = Object.assign({}, r); delete c._recs; up.push(c); } }
    if (up.length) ops.push({ t: tb, op: 'upsert', rows: up });
    if (tb === 'golden_profile_versions') { const m = new Map(old); cur.forEach((v, k) => m.set(k, v)); next[tb] = m; continue; }
    if (tb !== 'audit_events') {
      const del = []; old.forEach((v, k) => { if (!cur.has(k)) del.push(delKey(tb, k)); });
      if (del.length) ops.push({ t: tb, op: 'delete', keys: del });
      if (tb === 'canonical_entities' && del.length) {
        // perfil eliminado (todos os registros removidos): remove também o histórico de versões, que contém dados pessoais
        const recs = new Set(t.records.map(r => r.id)), gone = [];
        for (const id of del) { const rs = st.entRecs.get(id) || []; if (rs.length && rs.every(x => !recs.has(x))) gone.push(id); }
        if (gone.length) { ops.push({ t: 'golden_profile_versions', op: 'purge', keys: gone }); const gv = st.maps.golden_profile_versions || new Map(); Array.from(gv.keys()).forEach(k => { if (gone.includes(k.split('|')[0])) gv.delete(k); }); }
      }
    } else { old.forEach((v, k) => cur.set(k, v)); }
    next[tb] = cur;
  }
  const cfg = CX.hash(j([t.config, t.spend, t.seq, t.cacheHits]));
  return { ops, next, T, cfg, tenant: cfg !== st.cfg ? { config_json: t.config, spend: t.spend, seq: t.seq, cache_hits: t.cacheHits } : null };
}
async function push(t, onProgress) {
  if (!t.remote || !t._sync) return { written: 0 };
  const dd = diff(t); if (!dd.ops.length && !dd.tenant) return { written: 0 };
  // fatia em requisições de até ~400 linhas
  const reqs = []; let cur = { ops: [] }, n = 0;
  for (const op of dd.ops) {
    const list = op.op === 'upsert' ? op.rows : op.keys;
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      if (n + part.length > 400 && cur.ops.length) { reqs.push(cur); cur = { ops: [] }; n = 0; }
      cur.ops.push(op.op === 'upsert' ? { t: op.t, op: 'upsert', rows: part } : { t: op.t, op: op.op, keys: part }); n += part.length;
    }
  }
  if (cur.ops.length || dd.tenant) { cur.tenant = dd.tenant; reqs.push(cur); }
  let written = 0; const denied = [];
  for (let i = 0; i < reqs.length; i++) {
    const r = await call('POST', '/t/' + encodeURIComponent(t.id) + '/sync', reqs[i]);
    written += r.written; denied.push(...(r.denied || []));
    if (onProgress) onProgress(i + 1, reqs.length);
  }
  const st = t._sync; for (const tb in dd.next) st.maps[tb] = dd.next[tb];
  if (dd.T.canonical_entities) { st.entRecs.clear(); for (const r of dd.T.canonical_entities) st.entRecs.set(r.id, r._recs); st.derived = t.derived; }
  st.cfg = dd.cfg;
  return { written, denied };
}

/* ---------- carga ---------- */
function mergeCfg(base, saved) {
  const c = Object.assign({}, base, saved || {});
  ['dqi', 'icp', 'budget', 'workflows'].forEach(k => { c[k] = Object.assign({}, base[k], (saved || {})[k] || {}); });
  return c;
}
async function loadTenant(id, role, onProgress) {
  const d = await call('GET', '/t/' + encodeURIComponent(id) + '/load');
  const t = CX.newTenant(d.tenant.id, d.tenant.name);
  t.remote = true; t.role = role; t.idp = uid().slice(0, 5) + '_';
  t.salt = d.tenant.salt; t.config = mergeCfg(CX.defaultConfig(), parse(d.tenant.config_json, {}));
  t.spend = d.tenant.spend || 0; t.seq = d.tenant.seq || 0; t.cacheHits = d.tenant.cache_hits || 0;
  t.sources = d.sources.map(s => ({ id: s.id, name: s.name, type: s.type, origin: s.origin || '', owner: s.owner || '', legal_basis: s.legal_basis || '', purposes: parse(s.purposes_json, []), reliability: s.reliability, contract: s.contract || '', created_at: s.created_at, updated_at: s.updated_at }));
  t.imports = d.imports.map(i => { const x = parse(i.data_json, {}); return { id: i.id, sourceId: i.source_id, fileName: i.file_name, fileHash: i.file_hash, format: i.format, encoding: i.encoding, bytes: i.bytes, version: i.version, at: i.at, actor: i.actor, status: i.status, mapping: x.mapping || {}, total: i.total, cursor: x.cursor || i.total, parseErrors: x.parseErrors || [], rowErrors: x.rowErrors || [], st: x.st || { received: i.received, extracted: i.received, mapped: i.normalized, normalized: i.normalized, validated: i.validated }, ms: x.ms || { extract: 0, normalize: 0, resolve: 0 }, recIds: [], raw_key: i.raw_key }; });
  d.decisions.forEach(x => { t.decisions[x.kind][x.pair_key] = { at: x.at, actor: x.actor }; });
  d.mappings.forEach(m => { t.mappings[m.sig] = { map: parse(m.map_json, {}), at: m.at, used: m.used, fileName: m.file_name }; });
  t.snapshots = d.snapshots.map(s => ({ id: s.id, at: s.at, import_id: s.import_id, records: s.records, entities: s.entities, dqi: s.dqi, completeness: s.completeness, confidence: s.confidence }));
  t.modelVersions = d.models.map(m => ({ version: m.version, at: m.at, dqi: parse(m.dqi_json, {}), icp: parse(m.icp_json, {}), avg: m.avg_dqi }));
  t.enrichRuns = d.runs.map(r => parse(r.data_json, { id: r.id, at: r.at, actor: r.actor, state: r.state, cost: r.cost, filled: r.filled, changes: {}, byProvider: {}, steps: [] }));
  t.enrich = d.results.map(e => ({ id: e.id, record_id: e.record_id, field: e.field, value: e.value, provider: e.provider, run: e.run_id, at: e.at, method: e.method, verification: e.verification, note: e.note, confidence: e.confidence, synthetic: !!e.synthetic, cost: e.cost }));
  d.cache.forEach(c => { t.cache[c.cache_key] = 1; });
  t.executions = d.execs.map(e => ({ id: e.id, kind: e.kind, trigger: e.trigger, ref: e.ref, at: e.at, state: e.state, attempts: e.attempts, ms: e.ms, cost: e.cost, detail: e.detail }));
  t.segments = d.segs.map(s => { const x = parse(s.definition_json, {}); return { id: s.id, name: s.name, purpose: s.purpose, op: x.op || 'AND', rules: x.rules || [], at: s.at }; });
  d.supp.forEach(s => { t.suppression[s.key_hash] = { type: s.channel, at: s.at, reason: s.reason }; });
  t.erased = d.erased.map(e => ({ id: e.id, ref: e.ref_hash, records: e.records, at: e.at, actor: e.actor }));
  t.audit = d.audit.map(a => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, detail: a.detail, ref: a.ref }));
  let after = '', got = 0;
  while (true) {
    const r = await call('GET', '/t/' + encodeURIComponent(id) + '/records?limit=5000&after=' + encodeURIComponent(after));
    for (const x of r.rows) { const p = parse(x.payload_json, {}); t.records.push({ id: x.id, source_id: x.source_id, import_id: x.import_id, row: x.row_num, f: p.f || {}, flags: p.flags || null, observed_at: x.observed_at, type: x.entity_type }); }
    got += r.rows.length; if (onProgress) onProgress(got, d.records);
    if (!r.next) break; after = r.next;
  }
  CX.rebuild(t);
  // linha de base: o que veio do servidor já está gravado
  const T = tables(t, null), ents = T.canonical_entities; delete T.canonical_entities; delete T.golden_profile_versions;
  const srvCand = new Set(d.candidates.map(c => c.pair_key)); T.identity_match_candidates = T.identity_match_candidates.filter(c => srvCand.has(c.pair_key));
  snapshot(t, T);
  const st = t._sync, ent = st.maps.canonical_entities = new Map(), gv = st.maps.golden_profile_versions = new Map(), srv = new Map(d.entities.map(e => [e.id, e.sig]));
  d.entities.forEach(e => gv.set(e.id + '|' + e.sig, '1'));
  srv.forEach((sig, id) => ent.set(id, null));
  for (const r of ents) { st.entRecs.set(r.id, r._recs); if (srv.get(r.id) === r.sig) ent.set(r.id, CX.hash(j(r))); }
  d.candidates.forEach(c => { if (!st.maps.identity_match_candidates.has(c.pair_key)) st.maps.identity_match_candidates.set(c.pair_key, null); });
  st.derived = t.derived;
  return t;
}

root.CXSync = {
  async init() {
    try { S.session = await call('GET', '/session'); return S.session; }
    catch (e) { if (e.status === 401) { S.session = { error: e.message, status: 401 }; return S.session; } return null; }
  },
  session: () => S.session,
  loadTenant, push,
  createTenant: name => call('POST', '/tenants', { name }),
  members: tid => call('GET', '/t/' + encodeURIComponent(tid) + '/members').then(r => r.members),
  setMember: (tid, email, role) => call('POST', '/t/' + encodeURIComponent(tid) + '/members', { email, role }),
  removeMember: (tid, email) => call('DELETE', '/t/' + encodeURIComponent(tid) + '/members/' + encodeURIComponent(email)),
  uploadRaw: (tid, imp, name, bytes) => call('POST', '/t/' + encodeURIComponent(tid) + '/raw?import=' + encodeURIComponent(imp) + '&name=' + encodeURIComponent(name), undefined, bytes),
  deleteRaw: (tid, imp) => call('POST', '/t/' + encodeURIComponent(tid) + '/raw-delete?import=' + encodeURIComponent(imp))
};
})(typeof window !== 'undefined' ? window : globalThis);
