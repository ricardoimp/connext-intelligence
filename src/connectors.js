/* CONNEXT INTELLIGENCE · conectores de entrada
   Cada conector devolve { headers, rows, cursor, more } a partir do cursor incremental anterior.
   Credenciais chegam já decifradas do cofre e nunca são registradas em log. */
import postgres from 'postgres';
import mysql from 'mysql2/promise';

export const TYPES = {
  webhook: { label: 'Webhook / API de entrada', secret: false, fields: [] },
  google_sheets: { label: 'Google Sheets', secret: 'JSON da conta de serviço do Google', fields: [['spreadsheet_id', 'ID da planilha'], ['range', 'Aba e intervalo (ex.: Leads!A:Z)']] },
  hubspot: { label: 'HubSpot', secret: 'Token do aplicativo privado do HubSpot', fields: [['object', 'Objeto (contacts ou companies)']] },
  salesforce: { label: 'Salesforce', secret: 'Client secret do aplicativo conectado', fields: [['instance_url', 'URL da instância (https://suaempresa.my.salesforce.com)'], ['client_id', 'Client ID do aplicativo conectado'], ['object', 'Objeto (Lead ou Contact)']] },
  postgres: { label: 'PostgreSQL', secret: 'URL de conexão (postgres://usuario:senha@host:5432/banco)', fields: [['query', 'Consulta SELECT'], ['cursor_column', 'Coluna incremental (opcional, ex.: updated_at)']] },
  mysql: { label: 'MySQL', secret: 'URL de conexão (mysql://usuario:senha@host:3306/banco)', fields: [['query', 'Consulta SELECT'], ['cursor_column', 'Coluna incremental (opcional, ex.: updated_at)']] }
};

const str = v => v == null ? '' : (v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
const table = objs => { const headers = []; objs.forEach(o => Object.keys(o).forEach(k => { if (!headers.includes(k)) headers.push(k); })); return { headers, rows: objs.map(o => headers.map(h => str(o[h]))) }; };
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]{0,62}$/;
function safeSelect(q) {
  const s = String(q || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s) || s.includes(';')) throw Object.assign(new Error('A consulta precisa ser um único SELECT (ou WITH ... SELECT), sem ponto e vírgula no meio.'), { status: 400 });
  if (/\b(insert|update|delete|drop|alter|create|grant|truncate|copy|call|exec)\b/i.test(s)) throw Object.assign(new Error('A consulta contém um comando de escrita. Use um usuário só de leitura e apenas SELECT.'), { status: 400 });
  return s;
}
async function httpJson(url, opt, label) {
  const r = await fetch(url, opt); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* resposta não JSON */ }
  if (!r.ok) throw Object.assign(new Error(label + ' respondeu ' + r.status + ': ' + ((j && (j.message || j.error_description || (j.error && j.error.message) || j.error)) || t.slice(0, 160))), { status: 502 });
  return j;
}

/* ---------- Google Sheets (conta de serviço) ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function googleToken(saJson) {
  let sa; try { sa = JSON.parse(saJson); } catch (e) { throw Object.assign(new Error('O JSON da conta de serviço do Google é inválido.'), { status: 400 }); }
  const pem = String(sa.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const h = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))), p = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })));
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(h + '.' + p)));
  const j = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + h + '.' + p + '.' + sig }, 'Google');
  return j.access_token;
}
async function sheets(cfg, secret) {
  if (!cfg.spreadsheet_id) throw Object.assign(new Error('Informe o ID da planilha.'), { status: 400 });
  const tok = await googleToken(secret);
  const j = await httpJson('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(cfg.spreadsheet_id) + '/values/' + encodeURIComponent(cfg.range || 'A:Z') + '?valueRenderOption=FORMATTED_VALUE', { headers: { authorization: 'Bearer ' + tok } }, 'Google Sheets');
  const vals = j.values || []; if (!vals.length) return { headers: [], rows: [], cursor: null, more: false };
  const headers = vals[0].map((h, i) => String(h).trim() || 'coluna_' + (i + 1));
  return { headers, rows: vals.slice(1).map(r => headers.map((_, i) => str(r[i]))), cursor: null, more: false, fullSnapshot: true };
}

/* ---------- HubSpot (incremental por última modificação) ---------- */
async function hubspot(cfg, secret, cursor, limitPages) {
  const obj = cfg.object === 'companies' ? 'companies' : 'contacts';
  const props = obj === 'contacts'
    ? ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'jobtitle', 'city', 'state', 'zip', 'website', 'lifecyclestage', 'hs_lead_status', 'notes_last_contacted', 'createdate', 'hs_lastmodifieddate']
    : ['name', 'domain', 'phone', 'city', 'state', 'zip', 'industry', 'lifecyclestage', 'notes_last_contacted', 'createdate', 'hs_lastmodifieddate'];
  const since = cursor || '0', objs = []; let after, maxTs = +since, pages = 0, more = false;
  do {
    const body = { filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GT', value: since }] }], sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }], properties: props, limit: 100 };
    if (after) body.after = after;
    const j = await httpJson('https://api.hubapi.com/crm/v3/objects/' + obj + '/search', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }, 'HubSpot');
    for (const r of j.results || []) {
      const p = r.properties || {}; const ts = Date.parse(p.hs_lastmodifieddate || r.updatedAt || ''); if (ts > maxTs) maxTs = ts;
      objs.push(obj === 'contacts'
        ? { 'Nome': [p.firstname, p.lastname].filter(Boolean).join(' '), 'Email': p.email, 'Telefone': p.phone || p.mobilephone, 'Empresa': p.company, 'Cargo': p.jobtitle, 'Cidade': p.city, 'Estado': p.state, 'CEP': p.zip, 'Site': p.website, 'Etapa': p.lifecyclestage, 'Observações': p.hs_lead_status ? 'Status do lead no HubSpot: ' + p.hs_lead_status : '', 'Último contato': p.notes_last_contacted ? String(p.notes_last_contacted).slice(0, 10) : '', 'Data de cadastro': p.createdate ? String(p.createdate).slice(0, 10) : '', 'ID HubSpot': r.id }
        : { 'Razão Social': p.name, 'Site': p.domain, 'Telefone': p.phone, 'Cidade': p.city, 'Estado': p.state, 'CEP': p.zip, 'Setor': p.industry, 'Etapa': p.lifecyclestage, 'Último contato': p.notes_last_contacted ? String(p.notes_last_contacted).slice(0, 10) : '', 'Data de cadastro': p.createdate ? String(p.createdate).slice(0, 10) : '', 'ID HubSpot': r.id });
    }
    after = j.paging && j.paging.next && j.paging.next.after; pages++;
    if (after && pages >= limitPages) { more = true; break; }
  } while (after);
  return Object.assign(table(objs), { cursor: String(maxTs), more });
}

/* ---------- Salesforce (client credentials, incremental) ---------- */
async function salesforce(cfg, secret, cursor) {
  const base = String(cfg.instance_url || '').replace(/\/+$/, '');
  if (!/^https:\/\/[\w.-]+\.(salesforce|force)\.com$/.test(base)) throw Object.assign(new Error('URL da instância Salesforce inválida.'), { status: 400 });
  const tok = await httpJson(base + '/services/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(cfg.client_id || '') + '&client_secret=' + encodeURIComponent(secret) }, 'Salesforce');
  const isLead = (cfg.object || 'Lead') !== 'Contact';
  const fields = isLead ? 'Id, Name, Email, Phone, MobilePhone, Company, Title, City, State, PostalCode, Website, Status, Industry, Description, LastActivityDate, CreatedDate, LastModifiedDate'
    : 'Id, Name, Email, Phone, MobilePhone, Account.Name, Title, MailingCity, MailingState, MailingPostalCode, Description, LastActivityDate, CreatedDate, LastModifiedDate';
  const since = cursor || '2000-01-01T00:00:00Z';
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(since)) throw new Error('Cursor Salesforce inválido.');
  const q = 'SELECT ' + fields + ' FROM ' + (isLead ? 'Lead' : 'Contact') + ' WHERE LastModifiedDate > ' + since + ' ORDER BY LastModifiedDate ASC LIMIT 2000';
  const j = await httpJson(tok.instance_url + '/services/data/v60.0/query?q=' + encodeURIComponent(q), { headers: { authorization: 'Bearer ' + tok.access_token } }, 'Salesforce');
  let max = since;
  const objs = (j.records || []).map(r => { if (r.LastModifiedDate > max) max = r.LastModifiedDate; return isLead
    ? { 'Nome': r.Name, 'Email': r.Email, 'Telefone': r.Phone || r.MobilePhone, 'Empresa': r.Company, 'Cargo': r.Title, 'Cidade': r.City, 'Estado': r.State, 'CEP': r.PostalCode, 'Site': r.Website, 'Status': r.Status, 'Setor': r.Industry, 'Observações': r.Description, 'Último contato': r.LastActivityDate, 'Data de cadastro': String(r.CreatedDate || '').slice(0, 10), 'ID Salesforce': r.Id }
    : { 'Nome': r.Name, 'Email': r.Email, 'Telefone': r.Phone || r.MobilePhone, 'Empresa': r.Account && r.Account.Name, 'Cargo': r.Title, 'Cidade': r.MailingCity, 'Estado': r.MailingState, 'CEP': r.MailingPostalCode, 'Observações': r.Description, 'Último contato': r.LastActivityDate, 'Data de cadastro': String(r.CreatedDate || '').slice(0, 10), 'ID Salesforce': r.Id }; });
  return Object.assign(table(objs), { cursor: max.replace(/\.000\+0000$/, 'Z').replace(/\+0000$/, 'Z'), more: (j.records || []).length === 2000 });
}

/* ---------- Bancos externos (somente leitura) ---------- */
async function pg(cfg, secret, cursor, limit) {
  const q = safeSelect(cfg.query), col = cfg.cursor_column;
  if (col && !IDENT.test(col)) throw Object.assign(new Error('Nome da coluna incremental inválido.'), { status: 400 });
  const sql = postgres(secret, { max: 1, fetch_types: false, connect_timeout: 15, idle_timeout: 5, prepare: false });
  try {
    const rows = col ? await sql.unsafe('SELECT * FROM (' + q + ') AS src WHERE ' + (cursor ? col + ' > $1' : 'TRUE') + ' ORDER BY ' + col + ' ASC LIMIT ' + limit, cursor ? [cursor] : [])
      : await sql.unsafe('SELECT * FROM (' + q + ') AS src LIMIT ' + limit);
    const objs = Array.from(rows).map(r => Object.assign({}, r));
    const last = col && objs.length ? str(objs[objs.length - 1][col]) : cursor;
    return Object.assign(table(objs), { cursor: last || null, more: objs.length === limit, fullSnapshot: !col });
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
}
async function my(cfg, secret, cursor, limit) {
  const q = safeSelect(cfg.query), col = cfg.cursor_column;
  if (col && !IDENT.test(col)) throw Object.assign(new Error('Nome da coluna incremental inválido.'), { status: 400 });
  const conn = await mysql.createConnection({ uri: secret, disableEval: true, connectTimeout: 15000 });
  try {
    const [rows] = col ? await conn.query('SELECT * FROM (' + q + ') AS src WHERE ' + (cursor ? '`' + col.replace(/`/g, '') + '` > ?' : 'TRUE') + ' ORDER BY `' + col.replace(/`/g, '') + '` ASC LIMIT ' + limit, cursor ? [cursor] : [])
      : await conn.query('SELECT * FROM (' + q + ') AS src LIMIT ' + limit);
    const objs = rows.map(r => Object.assign({}, r));
    const last = col && objs.length ? str(objs[objs.length - 1][col]) : cursor;
    return Object.assign(table(objs), { cursor: last || null, more: objs.length === limit, fullSnapshot: !col });
  } finally { await conn.end().catch(() => {}); }
}

export async function fetchBatch(type, cfg, secret, cursor, opts) {
  const limit = (opts && opts.limit) || 5000;
  if (type === 'google_sheets') return sheets(cfg, secret);
  if (type === 'hubspot') return hubspot(cfg, secret, cursor, opts && opts.sample ? 1 : 20);
  if (type === 'salesforce') return salesforce(cfg, secret, cursor);
  if (type === 'postgres') return pg(cfg, secret, cursor, opts && opts.sample ? 20 : limit);
  if (type === 'mysql') return my(cfg, secret, cursor, opts && opts.sample ? 20 : limit);
  throw Object.assign(new Error('Este conector recebe dados por envio (webhook), não por leitura.'), { status: 400 });
}
