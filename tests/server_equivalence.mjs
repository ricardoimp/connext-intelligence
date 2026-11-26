// Prova de equivalência: perfis calculados no servidor (fila incremental, código real do Worker, banco SQLite com o
// esquema de produção) contra o recálculo completo do tenant no motor. Qualquer diferença reprova.
// Uso: node tests/server_equivalence.mjs [pessoas] [semente]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import '../public/engine.js';
import { processQueue, refreshStats, refreshCandidates } from '../src/profiles.js';
import worker from '../src/index.js';
const CX = globalThis.CX;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0); CX.setNow(NOW);
const N = +process.argv[2] || 2500; let seed = +process.argv[3] || 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];

/* ---------- banco: shim do D1 sobre SQLite ---------- */
const db = new DatabaseSync(':memory:');
const norm = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new Stmt(this.sql, a.map(norm)); }
  exec() { const p = db.prepare(this.sql); if (/^\s*(select|with)\b|\breturning\b/i.test(this.sql)) return { results: p.all(...this.args), meta: {} }; const r = p.run(...this.args); return { results: [], meta: { changes: r.changes } }; }
  async all() { return this.exec(); }
  async first() { const r = this.exec().results; return r.length ? r[0] : null; }
  async run() { return this.exec(); }
}
const env = { DB: { prepare: sql => new Stmt(sql), batch: async st => { db.exec('BEGIN'); try { const o = st.map(s => s.exec()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } }, exec: async sql => db.exec(sql) }, DEV_USER: 'admin@teste.local', AI_MOCK: '1' };
const mig = f => db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
const migs = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
migs.filter(f => f < '0007').forEach(mig);

/* ---------- dados sintéticos com todos os casos difíceis ---------- */
const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Hugo', 'Isabel', 'João', 'Karina', 'Lucas', 'Marina', 'Nelson', 'Olívia', 'Paulo'];
const LAST = ['Silva', 'Souza', 'Lima', 'Costa', 'Pereira', 'Almeida', 'Ribeiro', 'Carvalho', 'Gomes', 'Martins'];
const CITY = ['São Paulo', 'Campinas', 'Santos', 'Osasco'], CORP = ['acme', 'globex', 'initech', 'umbrella', 'hooli'];
const cpfOf = n => { const d = String(100000000 + n).slice(0, 9).split('').map(Number); let s = 0; for (let i = 0; i < 9; i++) s += d[i] * (10 - i); let a = (s * 10) % 11 % 10; d.push(a); s = 0; for (let i = 0; i < 10; i++) s += d[i] * (11 - i); d.push((s * 10) % 11 % 10); return d.join(''); };
const phoneOf = n => '(11) 9' + String(1000 + (n % 9000)) + '-' + String(1000 + ((n * 7) % 9000));
const people = [];
for (let i = 0; i < N; i++) {
  const nm = pick(FIRST) + ' ' + pick(LAST) + (rnd() < 0.5 ? ' ' + pick(LAST) : ''), corp = rnd() < 0.4 ? pick(CORP) : null;
  people.push({ nm, email: nm.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ /g, '.') + i + '@' + (corp ? corp + '.example' : 'mail.example'), phone: phoneOf(i * 13 + 5), cpf: rnd() < 0.5 ? cpfOf(i * 3 + 11) : '', city: pick(CITY), cep: rnd() < 0.3 ? '0' + (1000000 + (i % 50) * 7) : '', org: corp ? corp.toUpperCase() + ' Ltda' : '', job: rnd() < 0.3 ? pick(['Gerente', 'Analista', 'Diretor']) : '' });
}
const CALL = '(11) 4000-0000', NEAR = '(11) 4000-1111';  // bloco gigante (call center) e bloco que vai cruzar o limite
const line = r => [r.nm, r.email, r.phone, r.cpf, r.city, r.cep, r.org, r.job, r.mac || ''].map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',');
const HEAD = 'nome,email,telefone,cpf,cidade,cep,empresa,cargo,mac';
function fileA() {
  const rows = [];
  people.forEach((p, i) => {
    rows.push(Object.assign({}, p, { mac: i % 5 === 0 ? '9A:73:2E:A5:' + String(10 + i % 80) + ':02' : '' }));
    if (rnd() < 0.35) rows.push(Object.assign({}, p, { phone: '', cpf: rnd() < 0.5 ? p.cpf : '', nm: rnd() < 0.5 ? p.nm.toUpperCase() : p.nm.split(' ')[0] + ' ' + p.nm.split(' ').slice(-1)[0] }));  // mesma pessoa por e-mail
    if (rnd() < 0.2) rows.push(Object.assign({}, p, { email: 'alt' + i + '@mail.example', job: '' }));  // mesma pessoa por telefone
    if (rnd() < 0.03 && p.cpf) rows.push(Object.assign({}, p, { cpf: cpfOf(i * 3 + 999999), phone: '' }));  // documento divergente: veto
    if (rnd() < 0.02) rows.push(Object.assign({}, p, { email: 'invalido@', phone: '123' }));  // inválidos
  });
  for (let i = 0; i < 230; i++) rows.push({ nm: pick(FIRST) + ' ' + pick(LAST), email: 'cc' + i + '@mail.example', phone: CALL, city: pick(CITY) });
  for (let i = 0; i < 195; i++) rows.push({ nm: pick(FIRST) + ' ' + pick(LAST) + ' Neto', email: 'nr' + i + '@mail.example', phone: NEAR, city: pick(CITY) });
  for (let i = 0; i < 40; i++) rows.push({ nm: 'Mariana Torres Vidal', email: 'mtv' + i + '@' + pick(CORP) + '.example', city: pick(CITY), cep: i % 3 ? '01310100' : '', org: i % 2 ? 'ACME Ltda' : '' });  // homônimos
  return HEAD + '\n' + rows.map(line).join('\n');
}
function fileOrgs() {
  return 'empresa,cnpj,email,cidade\n' + CORP.map((c, i) => [c.toUpperCase() + ' Ltda', ['11222333000181', '11444777000161', '45997418000153', '60701190000104', '33000167000101'][i], 'contato@' + c + '.example', pick(CITY)].join(',')).join('\n') + '\nACME Ltda,11222333000181,financeiro@acme.example,São Paulo';
}
function fileB() {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ nm: pick(FIRST) + ' ' + pick(LAST), email: 'nb' + i + '@mail.example', phone: NEAR });  // cruza 200: bloco deixa de valer
  for (let i = 0; i < 300; i++) { const a = people[Math.floor(rnd() * N)], b = people[Math.floor(rnd() * N)]; rows.push({ nm: a.nm, email: a.email, phone: rnd() < 0.3 ? b.phone : a.phone, city: a.city, job: 'Coordenador' }); }  // novos registros que unem perfis
  for (let i = 0; i < 25; i++) rows.push({ nm: 'Mariana Torres Vidal', email: 'mtvb' + i + '@globex.example', cep: '01310100' });
  for (let i = 0; i < 200; i++) { const p = people[N - 1 - i]; rows.push(Object.assign({}, p, { email: '', city: 'Santos' })); }
  return HEAD + '\n' + rows.map(line).join('\n');
}

/* ---------- referência: motor com recálculo completo ---------- */
const t = CX.newTenant('tx', 'Teste');
const S1 = CX.addSource(t, { name: 'CRM', type: 'CRM', origin: 'crm interno', owner: 'Proprietário A', legal_basis: 'consentimento', purposes: ['analytics', 'enrichment', 'marketing_contact'], reliability: 0.9, contract: 'c1' }, 'teste');
const S2 = CX.addSource(t, { name: 'Wi-Fi', type: 'Planilha', origin: 'wifi', owner: 'Proprietário B', legal_basis: 'legitimo_interesse', purposes: ['analytics'], reliability: 0.6 }, 'teste');
const S3 = CX.addSource(t, { name: 'Empresas', type: 'Planilha', origin: 'cadastro', owner: 'Proprietário A', legal_basis: 'contrato', purposes: ['analytics', 'enrichment'], reliability: 0.8, contract: 'c2' }, 'teste');
CX.importText(t, 'crm.csv', fileA(), S1.id, NOW - 40 * 86400000, 'teste');
CX.importText(t, 'empresas.csv', fileOrgs(), S3.id, NOW - 30 * 86400000, 'teste');
CX.rebuild(t);
// decisões humanas, enriquecimento e supressão
const ps = t.derived.profiles.filter(p => p.type === 'person');
const recA = ps[3].anchor, recB = ps[ps.length - 5].anchor; CX.decide(t, recA < recB ? recA + '|' + recB : recB + '|' + recA, 'merge', 'teste');  // fusão manual entre componentes sem chave em comum
if (t.derived.candidates[0]) CX.decide(t, t.derived.candidates[0].key, 'reject', 'teste');
const multi = t.derived.profiles.find(p => p.record_ids.length >= 3); CX.splitRecord(t, multi.record_ids[1], true, 'teste');
CX.runEnrichment(t, t.derived.profiles.slice(0, 400).map(p => p.id), ['ddd_uf', 'master_link', 'domain_site'], { actor: 'teste' });
const supP = t.derived.profiles.find(p => p.fields.email); CX.suppress(t, 'email', supP.fields.email.value, 'teste');
CX.rebuild(t);

/* ---------- banco: grava o estado como a produção tem hoje ---------- */
const ins = (tb, o) => { const k = Object.keys(o); db.prepare('INSERT INTO ' + tb + ' (' + k.join(',') + ') VALUES (' + k.map(() => '?').join(',') + ')').run(...k.map(x => norm(o[x]))); };
ins('tenants', { id: 'tx', name: 'Teste', salt: t.salt, config_json: JSON.stringify(t.config), created_at: NOW, updated_at: NOW });
ins('memberships', { tenant_id: 'tx', email: 'admin@teste.local', role_id: 'admin', created_at: NOW });
const srcRow = s => ({ tenant_id: 'tx', id: s.id, name: s.name, type: s.type, origin: s.origin, owner: s.owner, legal_basis: s.legal_basis, purposes_json: JSON.stringify(s.purposes || []), reliability: s.reliability, contract: s.contract, created_at: NOW, updated_at: NOW });
t.sources.forEach(s => ins('data_sources', srcRow(s)));
t.imports.forEach(im => ins('import_jobs', { tenant_id: 'tx', id: im.id, source_id: im.sourceId, file_name: im.fileName || im.name || 'arquivo', status: 'concluído', at: im.at }));
const recRow = r => ({ tenant_id: 'tx', id: r.id, source_id: r.source_id, import_id: r.import_id, row_num: r.row, entity_type: r.type, observed_at: r.observed_at, payload_json: JSON.stringify({ f: r.f, flags: r.flags, origin: r.origin || null }), created_at: NOW });
t.records.forEach(r => ins('source_records', recRow(r)));
['merge', 'reject', 'split'].forEach(k => Object.keys(t.decisions[k]).forEach(pk => ins('identity_decisions', { tenant_id: 'tx', pair_key: pk, kind: k, actor: 'teste', at: NOW })));
t.enrich.forEach((e, i) => ins('enrichment_results', { tenant_id: 'tx', id: 'er' + i, record_id: e.record_id, field: e.field, value: e.value, provider: e.provider, run_id: e.run, at: e.at, method: e.method, verification: e.verification, note: e.note, confidence: e.confidence, synthetic: e.synthetic ? 1 : 0, cost: e.cost }));
Object.keys(t.cache).forEach(k => ins('enrichment_cache', { tenant_id: 'tx', cache_key: k }));
Object.keys(t.suppression).forEach(k => ins('suppression_registry', { tenant_id: 'tx', key_hash: k, channel: t.suppression[k].type, at: NOW }));
mig('0007_server_profiles.sql');

/* ---------- comparação ---------- */
async function drain() { for (let i = 0; i < 100000; i++) { const r = await processQueue(env, 'tx', 60000, true); if (r.busy) continue; if (!r.left) break; } const ctx = { decs: db.prepare('SELECT kind, pair_key FROM identity_decisions WHERE tenant_id = ?').all('tx') }; await refreshCandidates(env, ctx, 'tx'); await refreshStats(env, 'tx', true); }
function serverTenant() {
  const st = JSON.parse(db.prepare('SELECT stats_json FROM tenant_stats WHERE tenant_id = ?').get('tx').stats_json);
  const rows = db.prepare('SELECT id, card_json AS card FROM canonical_entities WHERE tenant_id = ? AND card_json IS NOT NULL ORDER BY id').all('tx');
  const s = CX.newTenant('tx', 'Teste'); s.decisions = t.decisions; s.stages = {};
  CX.fromCards(s, rows, CX.serverCandidates(s, db.prepare("SELECT pair_key, score, reasons_json, ent_a, ent_b, kind FROM identity_match_candidates WHERE tenant_id = ? AND status = 'pendente' AND ent_a IS NOT NULL").all('tx')), st.records, { oversized: st.oversized });
  const rec = {}; db.prepare('SELECT id, entity_id FROM source_records WHERE tenant_id = ?').all('tx').forEach(r => rec[r.id] = r.entity_id);
  return { s, st, rec, mode: db.prepare('SELECT profiles_mode FROM tenants WHERE id = ?').get('tx').profiles_mode };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function compare(label) {
  CX.rebuild(t); const R = t.derived, { s, st, rec, mode } = serverTenant(), D = s.derived, errs = [];
  const err = m => { if (errs.length < 25) errs.push(m); errs.n = (errs.n || 0) + 1; };
  if (mode !== 'server') err('modo ' + mode);
  if (R.profiles.length !== D.profiles.length) err('perfis ' + R.profiles.length + ' x ' + D.profiles.length);
  for (const p of R.profiles) {
    const q = D.byId[p.id]; if (!q) { err('perfil ausente no servidor ' + p.id); continue; }
    const card = CX.fromCard(p.id, JSON.parse(JSON.stringify(CX.card(p, {}))));  // a mesma projeção que o servidor grava
    for (const k of ['type', 'name', 'level', 'scores', 'sources', 'record_count', 'fields', 'invalid', 'extra', 'missing', 'conflicts', 'elig', 'eligWhy', 'suppressed', 'enriched', 'merged', 'anchor', 'flags', 'fstat', 'autoMerges'])
      if (!eq(card[k], q[k])) err(p.id + ' · ' + k + ': ' + JSON.stringify(card[k]).slice(0, 160) + ' x ' + JSON.stringify(q[k]).slice(0, 160));
    if ((p.org_id || null) !== (q.org_id || null)) err(p.id + ' · organização vinculada ' + p.org_id + ' x ' + q.org_id);
    for (const rid of p.record_ids) if (rec[rid] !== p.id) err('registro ' + rid + ' no perfil ' + rec[rid] + ', esperado ' + p.id);
  }
  for (const k of ['duplicates', 'autoMerges', 'oversized']) if (R[k] !== D[k]) err(k + ' ' + R[k] + ' x ' + D[k]);
  if (!eq(R.avg, D.avg)) err('médias ' + JSON.stringify(R.avg) + ' x ' + JSON.stringify(D.avg));
  if (!eq(R.fieldStats, D.fieldStats)) for (const k in R.fieldStats) if (!eq(R.fieldStats[k], D.fieldStats[k])) err('estatística do campo ' + k + ' ' + JSON.stringify(R.fieldStats[k]) + ' x ' + JSON.stringify(D.fieldStats[k]));
  const cr = new Map(R.candidates.map(c => { const a = R.recToEnt[c.a], b = R.recToEnt[c.b]; return [(a < b ? a + '|' + b : b + '|' + a), c]; }));
  const cd = new Map(D.candidates.map(c => [c.ea + '|' + c.eb, c]));
  if (cr.size !== cd.size) err('candidatos ' + cr.size + ' x ' + cd.size);
  cr.forEach((c, k) => { const o = cd.get(k); if (!o) err('candidato ausente ' + k + ' ' + c.reasons.join('; ')); else if (o.score !== c.score) err('pontuação do candidato ' + k + ' ' + c.score + ' x ' + o.score); });
  cd.forEach((c, k) => { if (!cr.has(k)) err('candidato a mais ' + k + ' ' + c.reasons.join('; ')); });
  if (st.records !== t.records.length) err('registros ' + t.records.length + ' x ' + st.records);
  const ok = !errs.n;
  console.log((ok ? 'OK    ' : 'FALHA ') + label + ' · ' + t.records.length + ' registros · ' + R.profiles.length + ' perfis · ' + R.candidates.length + ' candidatos · fusões ' + R.autoMerges + ' · blocos ignorados ' + R.oversized + (ok ? '' : ' · ' + errs.n + ' divergência(s)'));
  errs.forEach(e => console.log('   ' + e));
  return ok;
}
const waits = []; const ctx = { waitUntil: p => waits.push(p.catch(e => console.error('waitUntil', e.message))) };
async function api(method, path, body) {
  const r = await worker.fetch(new Request('http://localhost/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await Promise.all(waits.splice(0)); const j = await r.json(); if (process.env.DBG) console.log('api', path, r.status, JSON.stringify(j).slice(0, 300)); if (!j.ok) throw new Error(path + ': ' + j.error); return j;
}

let all = true;
// 1) migração: todo o tenant calculado pela fila do servidor
let t1 = Date.now(); await drain(); all = compare('Migração (fila completa, ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s)') && all;
// 2) importação nova pela API de sincronização: novos vínculos, bloco que passa de 200, homônimos
const before = new Set(t.records.map(r => r.id));
CX.importText(t, 'novos.csv', fileB(), S2.id, NOW - 2 * 86400000, 'teste');
const novos = t.records.filter(r => !before.has(r.id)), im = t.imports[t.imports.length - 1];
ins('import_jobs', { tenant_id: 'tx', id: im.id, source_id: im.sourceId, file_name: 'novos.csv', status: 'concluído', at: im.at, raw_key: 'brutos/novos.csv', provenance_json: '{}' });  // comprovante de origem, como o registerFile grava
for (let i = 0; i < novos.length; i += 500) await api('POST', '/t/tx/sync', { ops: [{ t: 'source_records', op: 'upsert', rows: novos.slice(i, i + 500).map(r => ({ id: r.id, source_id: r.source_id, import_id: r.import_id, row_num: r.row, entity_type: r.type, observed_at: r.observed_at, payload_json: { f: r.f, flags: r.flags, origin: r.origin || null } })) }] });
if (process.env.DBG) console.log('fila', db.prepare('SELECT COUNT(*) n, SUM(indexed) i FROM profile_queue').get(), 'registros', db.prepare('SELECT COUNT(*) n, COUNT(entity_id) e FROM source_records').get(), db.prepare('SELECT * FROM tenants').get().profiles_mode, db.prepare('SELECT profile_lock_until FROM tenants').get());
  t1 = Date.now(); await drain(); all = compare('Importação incremental (' + novos.length + ' registros, ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s)') && all;
// 3) decisões humanas pela API: fusão, rejeição, separação e desfazer
CX.rebuild(t); const c0 = t.derived.candidates[0], c1 = t.derived.candidates[1], big = t.derived.profiles.find(p => p.record_ids.length >= 4);
const dec = []; if (c0) { CX.decide(t, c0.key, 'merge', 'teste'); dec.push({ pair_key: c0.key, kind: 'merge', actor: 'teste', at: NOW }); }
if (c1) { CX.decide(t, c1.key, 'reject', 'teste'); dec.push({ pair_key: c1.key, kind: 'reject', actor: 'teste', at: NOW }); }
CX.splitRecord(t, big.record_ids[2], true, 'teste'); dec.push({ pair_key: big.record_ids[2], kind: 'split', actor: 'teste', at: NOW });
await api('POST', '/t/tx/sync', { ops: [{ t: 'identity_decisions', op: 'upsert', rows: dec }] });
const undo = Object.keys(t.decisions.split)[0]; CX.splitRecord(t, undo, false, 'teste');
await api('POST', '/t/tx/sync', { ops: [{ t: 'identity_decisions', op: 'delete', keys: [[undo, 'split']] }] });
await drain(); all = compare('Decisões humanas (fusão, rejeição, separação, desfazer)') && all;
// 4) exclusão de registros (inclusive do bloco gigante, que volta a ficar abaixo de 200) e mudança de fonte
const del = t.records.filter(r => r.f.phone && r.f.phone[0] && r.f.phone[0].value && CX.normalize('phone', CALL).value === r.f.phone[0].value).slice(0, 35).map(r => r.id).concat(t.records.slice(10, 40).map(r => r.id));
t.records = t.records.filter(r => !del.includes(r.id)); t.enrich = t.enrich.filter(e => !del.includes(e.record_id));
await api('POST', '/t/tx/sync', { ops: [{ t: 'source_records', op: 'delete', keys: del }] });
db.prepare('DELETE FROM enrichment_results WHERE tenant_id = ? AND record_id IN (' + del.map(() => '?').join(',') + ')').run('tx', ...del);
const s2 = t.sources.find(s => s.id === S2.id); s2.reliability = 0.95; s2.purposes = ['analytics', 'marketing_contact'];
await api('POST', '/t/tx/sync', { ops: [{ t: 'data_sources', op: 'upsert', rows: [{ id: s2.id, name: s2.name, type: s2.type, origin: s2.origin, owner: s2.owner, legal_basis: s2.legal_basis, purposes_json: s2.purposes, reliability: s2.reliability, contract: s2.contract || null, created_at: NOW, updated_at: NOW }] }] });
await drain(); all = compare('Exclusões e alteração de fonte') && all;
// 5) novo modelo de pontuação (limiar e pesos) vale para todos os perfis
t.config.autoT = 0.88; t.config.dqi.freshness = 25;
await api('POST', '/t/tx/sync', { ops: [], tenant: { config_json: t.config } }); if (process.env.DBG) console.log('cfg', db.prepare('SELECT config_json FROM tenants').get().config_json.slice(0, 120), db.prepare('SELECT COUNT(*) n FROM profile_queue').get());
await drain(); all = compare('Modelo novo (limiar de fusão e pesos)') && all;
// 6) oposição (supressão), eliminação de titular e enriquecimento interno executado no servidor
CX.rebuild(t);
const opp = t.derived.profiles.filter(p => p.fields.phone)[7]; CX.suppress(t, 'phone', opp.fields.phone.value, 'teste');
const kh = Object.keys(t.suppression).find(k => !db.prepare('SELECT 1 FROM suppression_registry WHERE key_hash = ?').get(k));
await api('POST', '/t/tx/sync', { ops: [{ t: 'suppression_registry', op: 'upsert', rows: [{ key_hash: kh, channel: 'phone', reason: 'oposição do titular', at: NOW }] }] });
const er = t.derived.profiles.find(p => p.record_ids.length >= 2 && p.type === 'person'); const erN = er.record_ids.length; CX.eraseEntity(t, er.id, 'teste');
const erR = await api('POST', '/t/tx/erase', { entity_id: er.id, ref_hash: 'x' }); if (erR.records !== erN) { console.log('FALHA eliminação: ' + erR.records + ' x ' + erN); all = false; }
await drain(); CX.rebuild(t);
const alvo = t.derived.profiles.filter(p => p.type === 'person').slice(0, 300).map(p => p.id);
const ref = Object.assign(Object.create(Object.getPrototypeOf(t)), t, { enrich: t.enrich.slice(), enrichRuns: [], audit: [], executions: [] }); CX.rebuild(ref);
CX.runEnrichment(ref, alvo, ['ddd_uf', 'master_link', 'domain_site'], { actor: 'teste' });
await api('POST', '/t/tx/reprocess', { entity_ids: alvo, op: 'enrich:ddd_uf,master_link,domain_site' }); await drain();
const srv = db.prepare('SELECT record_id, field, value, provider FROM enrichment_results WHERE tenant_id = ?').all('tx').map(e => e.record_id + '|' + e.field + '|' + e.value + '|' + e.provider).sort();
const exp = ref.enrich.map(e => e.record_id + '|' + e.field + '|' + e.value + '|' + e.provider).sort();
if (!eq(srv, exp)) { all = false; console.log('FALHA enriquecimento: ' + exp.length + ' esperados x ' + srv.length + ' no servidor'); exp.filter(x => !srv.includes(x)).slice(0, 5).forEach(x => console.log('   falta ' + x)); srv.filter(x => !exp.includes(x)).slice(0, 5).forEach(x => console.log('   sobra ' + x)); }
else console.log('OK    Enriquecimento no servidor · ' + (exp.length - t.enrich.length) + ' atributos novos, idênticos ao enriquecimento no tenant inteiro');
t.enrich = db.prepare('SELECT * FROM enrichment_results WHERE tenant_id = ?').all('tx').map(e => ({ id: e.id, record_id: e.record_id, field: e.field, value: e.value, provider: e.provider, run: e.run_id, at: e.at, method: e.method, verification: e.verification, note: e.note, confidence: e.confidence, synthetic: !!e.synthetic, cost: e.cost }));
all = compare('Oposição, eliminação de titular e perfis após enriquecimento') && all;
console.log(all ? '\nEQUIVALENTE: o servidor reproduz exatamente o cálculo completo.' : '\nNÃO EQUIVALENTE.');
process.exit(all ? 0 : 1);
