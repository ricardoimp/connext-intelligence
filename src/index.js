/* CONNEXT INTELLIGENCE · API (Cloudflare Worker)
   Toda rota /api exige identidade validada pelo Cloudflare Access (JWT RS256) e associação ao tenant.
   O restante das rotas é servido pelos arquivos estáticos em /public. */

const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSONH });
const fail = (status, error) => json({ ok: false, error }, status);
const now = () => Date.now();

/* ---------- Access JWT ---------- */
let JWKS = null, JWKS_AT = 0;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function keys(env) {
  if (JWKS && now() - JWKS_AT < 3600e3) return JWKS;
  const r = await fetch(env.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('certs ' + r.status);
  JWKS = (await r.json()).keys; JWKS_AT = now(); return JWKS;
}
async function verifyAccess(req, env) {
  if (env.DEV_USER) return { email: env.DEV_USER.toLowerCase() };           // apenas em desenvolvimento local
  let token = req.headers.get('cf-access-jwt-assertion');
  if (!token) { const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/); token = m && m[1]; }
  if (!token) return null;
  const [h, p, s] = token.split('.'); if (!s) return null;
  const head = JSON.parse(new TextDecoder().decode(b64u(h))), body = JSON.parse(new TextDecoder().decode(b64u(p)));
  let jwk = (await keys(env)).find(k => k.kid === head.kid);
  if (!jwk) { JWKS = null; jwk = (await keys(env)).find(k => k.kid === head.kid); }
  if (!jwk || head.alg !== 'RS256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || body.iss !== env.ACCESS_TEAM_DOMAIN || body.exp * 1000 < now() || !body.email) return null;
  return { email: String(body.email).toLowerCase() };
}

/* ---------- permissões ---------- */
const PERMS = {
  admin: ['import', 'merge', 'enrich', 'approve', 'segment', 'export', 'govern', 'config', 'members'],
  analista: ['import', 'merge', 'enrich', 'segment'],
  leitor: []
};
const can = (role, action) => (PERMS[role] || []).includes(action);

/* ---------- tabelas sincronizáveis ---------- */
// cols: colunas aceitas além de tenant_id; pk: chave; need: permissão mínima para escrever
const TABLES = {
  data_sources: { cols: ['id', 'name', 'type', 'origin', 'owner', 'legal_basis', 'purposes_json', 'reliability', 'contract', 'created_at', 'updated_at'], pk: ['id'], need: 'import' },
  import_jobs: { cols: ['id', 'source_id', 'file_name', 'file_hash', 'format', 'encoding', 'bytes', 'version', 'status', 'total', 'received', 'normalized', 'validated', 'row_errors', 'raw_key', 'actor', 'at', 'data_json'], pk: ['id'], need: 'import' },
  source_records: { cols: ['id', 'source_id', 'import_id', 'row_num', 'entity_type', 'observed_at', 'payload_json', 'created_at'], pk: ['id'], need: 'import' },
  mapping_templates: { cols: ['sig', 'file_name', 'map_json', 'used', 'at'], pk: ['sig'], need: 'import' },
  identity_decisions: { cols: ['pair_key', 'kind', 'actor', 'at'], pk: ['pair_key', 'kind'], need: 'merge' },
  identity_match_candidates: { cols: ['pair_key', 'score', 'reasons_json', 'status', 'updated_at'], pk: ['pair_key'], need: 'import' },
  canonical_entities: { cols: ['id', 'entity_type', 'name', 'level', 'dqi', 'completeness', 'confidence', 'freshness', 'qualification', 'contactability', 'record_count', 'org_id', 'suppressed', 'elig_json', 'sources_json', 'golden_json', 'sig', 'updated_at'], pk: ['id'], need: 'import' },
  golden_profile_versions: { cols: ['entity_id', 'sig', 'golden_json', 'scores_json', 'at'], pk: ['entity_id', 'sig'], need: 'import' },
  data_quality_assessments: { cols: ['id', 'at', 'import_id', 'records', 'entities', 'dqi', 'completeness', 'confidence'], pk: ['id'], need: 'import' },
  scoring_models: { cols: ['version', 'at', 'dqi_json', 'icp_json', 'avg_dqi'], pk: ['version'], need: 'config' },
  enrichment_requests: { cols: ['id', 'at', 'actor', 'state', 'cost', 'filled', 'data_json'], pk: ['id'], need: 'enrich' },
  enrichment_results: { cols: ['id', 'record_id', 'field', 'value', 'provider', 'run_id', 'at', 'method', 'verification', 'note', 'confidence', 'synthetic', 'cost'], pk: ['id'], need: 'enrich' },
  enrichment_cache: { cols: ['cache_key'], pk: ['cache_key'], need: 'enrich' },
  workflow_executions: { cols: ['id', 'kind', 'trigger', 'ref', 'at', 'state', 'attempts', 'ms', 'cost', 'detail'], pk: ['id'], need: 'import' },
  segments: { cols: ['id', 'name', 'purpose', 'definition_json', 'at'], pk: ['id'], need: 'segment' },
  suppression_registry: { cols: ['key_hash', 'channel', 'reason', 'at'], pk: ['key_hash'], need: 'govern' },
  erasure_requests: { cols: ['id', 'ref_hash', 'records', 'at', 'actor'], pk: ['id'], need: 'govern' },
  audit_events: { cols: ['id', 'at', 'actor', 'action', 'detail', 'ref'], pk: ['id'], need: null }
};
// eliminação e correção exigem 'govern' mesmo em tabelas que normalmente pedem outra permissão
const DELETE_NEED = { source_records: 'import', enrichment_results: 'enrich', canonical_entities: 'import', golden_profile_versions: 'govern', identity_match_candidates: 'import' };

async function runBatch(env, stmts) {
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
}
async function usage(env, tid, ep) {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO api_usage (tenant_id, day, endpoint, calls) VALUES (?,?,?,1) ON CONFLICT(tenant_id, day, endpoint) DO UPDATE SET calls = calls + 1').bind(tid, day, ep).run();
}
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
async function newSalt() { return hex(crypto.getRandomValues(new Uint8Array(16))); }
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tenant';

async function audit(env, tid, actor, action, detail, ref) {
  await env.DB.prepare('INSERT INTO audit_events (tenant_id, id, at, actor, action, detail, ref) VALUES (?,?,?,?,?,?,?)').bind(tid, 'srv_' + rid(), now(), actor, action, detail || '', ref || null).run();
}

/* ---------- sessão e associação ---------- */
async function session(env, email) {
  const t = now();
  await env.DB.prepare('INSERT INTO users (email, created_at, last_seen_at) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at').bind(email, t, t).run();
  let rows = (await env.DB.prepare('SELECT m.tenant_id AS id, t.name, m.role_id AS role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.email = ? AND t.status = ? ORDER BY t.created_at').bind(email, 'ativo').all()).results;
  const admins = String(env.BOOTSTRAP_ADMINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const domains = String(env.AUTO_JOIN_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!rows.length) {
    const home = env.HOME_TENANT_ID || 'connext';
    const exists = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(home).first();
    if (!exists && admins.includes(email)) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO tenants (id, name, salt, config_json, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?)').bind(home, env.HOME_TENANT_NAME || 'Connext Intelligence', await newSalt(), '{}', t, email, t),
        env.DB.prepare('INSERT INTO memberships (tenant_id, email, role_id, created_at, created_by) VALUES (?,?,?,?,?)').bind(home, email, 'admin', t, 'bootstrap')
      ]);
      await audit(env, home, email, 'tenant_criado', 'criação inicial pelo administrador');
    } else if (exists && (admins.includes(email) || domains.includes(email.split('@')[1]))) {
      const role = admins.includes(email) ? 'admin' : 'leitor';
      await env.DB.prepare('INSERT OR IGNORE INTO memberships (tenant_id, email, role_id, created_at, created_by) VALUES (?,?,?,?,?)').bind(home, email, role, t, 'auto').run();
      await audit(env, home, email, 'membro_adicionado', 'entrada automática como ' + role);
    }
    rows = (await env.DB.prepare('SELECT m.tenant_id AS id, t.name, m.role_id AS role FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.email = ? AND t.status = ? ORDER BY t.created_at').bind(email, 'ativo').all()).results;
  }
  return { ok: true, email, tenants: rows, permissions: PERMS, canCreateTenants: admins.includes(email) || rows.some(r => r.role === 'admin') };
}
async function member(env, tid, email) {
  return env.DB.prepare('SELECT role_id AS role FROM memberships WHERE tenant_id = ? AND email = ?').bind(tid, email).first();
}

/* ---------- carga do tenant ---------- */
async function load(env, tid) {
  const q = (sql, ...b) => env.DB.prepare(sql).bind(tid, ...b).all().then(r => r.results);
  const tenant = await env.DB.prepare('SELECT id, name, salt, config_json, spend, seq, cache_hits, created_at FROM tenants WHERE id = ?').bind(tid).first();
  const [sources, imports, decisions, candidates, mappings, snapshots, models, runs, results, cache, execs, segs, supp, erased, auditRows, count] = await Promise.all([
    q('SELECT * FROM data_sources WHERE tenant_id = ? ORDER BY created_at'),
    q('SELECT * FROM import_jobs WHERE tenant_id = ? ORDER BY at'),
    q('SELECT pair_key, kind, actor, at FROM identity_decisions WHERE tenant_id = ?'),
    q('SELECT pair_key FROM identity_match_candidates WHERE tenant_id = ?'),
    q('SELECT * FROM mapping_templates WHERE tenant_id = ?'),
    q('SELECT * FROM data_quality_assessments WHERE tenant_id = ? ORDER BY at'),
    q('SELECT * FROM scoring_models WHERE tenant_id = ? ORDER BY version'),
    q('SELECT * FROM enrichment_requests WHERE tenant_id = ? ORDER BY at'),
    q('SELECT * FROM enrichment_results WHERE tenant_id = ?'),
    q('SELECT cache_key FROM enrichment_cache WHERE tenant_id = ?'),
    q('SELECT * FROM (SELECT * FROM workflow_executions WHERE tenant_id = ? ORDER BY at DESC LIMIT 500) ORDER BY at'),
    q('SELECT * FROM segments WHERE tenant_id = ? ORDER BY at'),
    q('SELECT * FROM suppression_registry WHERE tenant_id = ?'),
    q('SELECT * FROM erasure_requests WHERE tenant_id = ? ORDER BY at'),
    q('SELECT * FROM (SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY at DESC LIMIT 2000) ORDER BY at'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM source_records WHERE tenant_id = ?').bind(tid).first()
  ]);
  const entities = await env.DB.prepare('SELECT id, sig FROM canonical_entities WHERE tenant_id = ?').bind(tid).all().then(r => r.results);
  return { ok: true, tenant, sources, imports, decisions, candidates, mappings, snapshots, models, runs, results, cache, execs, segs, supp, erased, audit: auditRows, entities, records: count.n };
}

/* ---------- sincronização ---------- */
async function sync(env, tid, email, role, body) {
  const stmts = [], denied = [];
  for (const op of body.ops || []) {
    const def = TABLES[op.t]; if (!def) { denied.push(op.t + ': tabela desconhecida'); continue; }
    if (op.op === 'upsert') {
      if (def.need && !can(role, def.need)) { denied.push(op.t); continue; }
      const cols = ['tenant_id'].concat(def.cols), sql = 'INSERT OR REPLACE INTO ' + op.t + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')';
      for (const row of op.rows || []) {
        const vals = [tid].concat(def.cols.map(c => { const v = row[c]; return v === undefined ? null : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v); }));
        if (op.t === 'source_records' && vals[def.cols.indexOf('created_at') + 1] == null) vals[def.cols.indexOf('created_at') + 1] = now();
        stmts.push(env.DB.prepare(sql).bind(...vals));
      }
    } else if (op.op === 'purge' && op.t === 'golden_profile_versions') {
      // eliminação de titular: remove todo o histórico de versões do perfil, que contém dados pessoais
      if (!can(role, 'govern')) { denied.push('histórico de perfil (eliminação)'); continue; }
      for (const id of op.keys || []) stmts.push(env.DB.prepare('DELETE FROM golden_profile_versions WHERE tenant_id = ? AND entity_id = ?').bind(tid, id));
    } else if (op.op === 'delete') {
      const need = DELETE_NEED[op.t] || def.need || 'govern';
      if (op.t === 'audit_events' || !can(role, need)) { denied.push(op.t + ' (exclusão)'); continue; }
      const sql = 'DELETE FROM ' + op.t + ' WHERE tenant_id = ? AND ' + def.pk.map(k => k + ' = ?').join(' AND ');
      for (const key of op.keys || []) stmts.push(env.DB.prepare(sql).bind(tid, ...(Array.isArray(key) ? key : [key])));
    }
  }
  if (body.tenant) {
    const cur = await env.DB.prepare('SELECT config_json FROM tenants WHERE id = ?').bind(tid).first();
    const cfg = body.tenant.config_json != null ? JSON.stringify(body.tenant.config_json) : null;
    if (cfg && cfg !== cur.config_json && !can(role, 'config') && cur.config_json !== '{}') denied.push('configuração');
    else if (role !== 'leitor') stmts.push(env.DB.prepare('UPDATE tenants SET config_json = COALESCE(?, config_json), spend = COALESCE(?, spend), seq = MAX(seq, COALESCE(?, 0)), cache_hits = COALESCE(?, cache_hits), updated_at = ? WHERE id = ?')
      .bind(cfg, body.tenant.spend ?? null, body.tenant.seq ?? null, body.tenant.cache_hits ?? null, now(), tid));
  }
  await runBatch(env, stmts);
  return { ok: true, written: stmts.length, denied };
}

/* ---------- roteador ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    let user;
    try { user = await verifyAccess(req, env); } catch (e) { return fail(503, 'Falha ao validar a sessão de login: ' + e.message); }
    if (!user) return fail(401, 'Sessão de login ausente ou inválida. Recarregue a página para entrar novamente.');
    const parts = url.pathname.split('/').filter(Boolean); // api, ...
    try {
      if (parts[1] === 'session' && req.method === 'GET') return json(await session(env, user.email));

      if (parts[1] === 'tenants' && req.method === 'POST' && parts.length === 2) {
        const s = await session(env, user.email); if (!s.canCreateTenants) return fail(403, 'Seu usuário não pode criar organizações.');
        const b = await req.json(), name = String(b.name || '').trim().slice(0, 80); if (!name) return fail(400, 'Informe o nome da organização.');
        let id = slug(name); if (await env.DB.prepare('SELECT 1 FROM tenants WHERE id = ?').bind(id).first()) id += '-' + rid().slice(0, 5);
        const t = now();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO tenants (id, name, salt, config_json, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, name, await newSalt(), '{}', t, user.email, t),
          env.DB.prepare('INSERT INTO memberships (tenant_id, email, role_id, created_at, created_by) VALUES (?,?,?,?,?)').bind(id, user.email, 'admin', t, user.email)
        ]);
        await audit(env, id, user.email, 'tenant_criado', name);
        return json({ ok: true, id, name, role: 'admin' });
      }

      if (parts[1] === 't' && parts[2]) {
        const tid = parts[2], m = await member(env, tid, user.email);
        if (!m) { return fail(403, 'Acesso negado: você não pertence a esta organização.'); }
        const role = m.role, sub = parts[3] || '';
        await usage(env, tid, req.method + ' ' + (sub || 'tenant'));

        if (sub === 'load' && req.method === 'GET') return json(await load(env, tid));

        if (sub === 'records' && req.method === 'GET') {
          const after = url.searchParams.get('after') || '', limit = Math.min(5000, +url.searchParams.get('limit') || 2000);
          const rows = (await env.DB.prepare('SELECT id, source_id, import_id, row_num, entity_type, observed_at, payload_json FROM source_records WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?').bind(tid, after, limit).all()).results;
          return json({ ok: true, rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
        }

        if (sub === 'sync' && req.method === 'POST') return json(await sync(env, tid, user.email, role, await req.json()));

        if (sub === 'raw' && req.method === 'POST') {
          if (!can(role, 'import')) return fail(403, 'Seu papel não permite importar arquivos.');
          const imp = String(url.searchParams.get('import') || '').replace(/[^\w.-]/g, ''), name = String(url.searchParams.get('name') || 'arquivo').replace(/[^\w.\- ]/g, '_').slice(0, 120);
          if (!imp) return fail(400, 'Importação não informada.');
          const key = tid + '/' + imp + '/' + name;
          await env.RAW.put(key, req.body, { httpMetadata: { contentType: req.headers.get('content-type') || 'application/octet-stream' }, customMetadata: { tenant: tid, import: imp, uploaded_by: user.email } });
          await env.DB.prepare('UPDATE import_jobs SET raw_key = ? WHERE tenant_id = ? AND id = ?').bind(key, tid, imp).run();
          await audit(env, tid, user.email, 'arquivo_bruto_armazenado', name, imp);
          return json({ ok: true, key });
        }

        if (sub === 'members') {
          if (req.method === 'GET') return json({ ok: true, members: (await env.DB.prepare('SELECT m.email, m.role_id AS role, m.created_at, m.created_by, u.last_seen_at FROM memberships m LEFT JOIN users u ON u.email = m.email WHERE m.tenant_id = ? ORDER BY m.created_at').bind(tid).all()).results });
          if (!can(role, 'members')) return fail(403, 'Apenas administradores gerenciam membros.');
          if (req.method === 'POST') {
            const b = await req.json(), email = String(b.email || '').trim().toLowerCase(), r = String(b.role || 'leitor');
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !PERMS[r]) return fail(400, 'E-mail ou papel inválido.');
            await env.DB.prepare('INSERT INTO memberships (tenant_id, email, role_id, created_at, created_by) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, email) DO UPDATE SET role_id = excluded.role_id').bind(tid, email, r, now(), user.email).run();
            await audit(env, tid, user.email, 'membro_definido', email + ' como ' + r);
            return json({ ok: true });
          }
          if (req.method === 'DELETE' && parts[4]) {
            const email = decodeURIComponent(parts[4]).toLowerCase();
            if (email === user.email) return fail(400, 'Você não pode remover a si mesmo.');
            await env.DB.prepare('DELETE FROM memberships WHERE tenant_id = ? AND email = ?').bind(tid, email).run();
            await audit(env, tid, user.email, 'membro_removido', email);
            return json({ ok: true });
          }
        }

        if (sub === 'entities' && req.method === 'GET') {
          const lvl = url.searchParams.get('min_level'), after = url.searchParams.get('after') || '', limit = Math.min(1000, +url.searchParams.get('limit') || 200);
          const rows = (await env.DB.prepare('SELECT id, entity_type, name, level, dqi, completeness, confidence, freshness, qualification, contactability, record_count, org_id, suppressed, elig_json, updated_at FROM canonical_entities WHERE tenant_id = ? AND id > ? AND level >= ? ORDER BY id LIMIT ?').bind(tid, after, +lvl || 0, limit).all()).results;
          return json({ ok: true, rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
        }

        if (sub === 'raw-delete' && req.method === 'POST') {
          if (!can(role, 'govern')) return fail(403, 'Seu papel não permite excluir arquivos brutos.');
          const imp = String(url.searchParams.get('import') || '').replace(/[^\w.-]/g, '');
          const row = await env.DB.prepare('SELECT raw_key FROM import_jobs WHERE tenant_id = ? AND id = ?').bind(tid, imp).first();
          if (row && row.raw_key) { await env.RAW.delete(row.raw_key); await env.DB.prepare('UPDATE import_jobs SET raw_key = NULL WHERE tenant_id = ? AND id = ?').bind(tid, imp).run(); await audit(env, tid, user.email, 'arquivo_bruto_excluido', imp); }
          return json({ ok: true });
        }
      }
      return fail(404, 'Rota não encontrada.');
    } catch (e) {
      return fail(500, 'Erro no servidor: ' + (e && e.message || e));
    }
  }
};
