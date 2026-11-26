/* Cofre simples: credenciais de conectores cifradas com AES-GCM.
   A chave nunca é gravada no banco de dados (veja material()). */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
// chave do cofre: segredo VAULT_KEY do Worker, quando configurado; senão, chave aleatória de 256 bits gerada pelo
// próprio servidor na primeira vez e guardada no bucket privado (fora do banco de dados onde ficam as credenciais cifradas)
const KEY_OBJ = '_sistema/cofre/chave-v1';
let cached = null;
async function material(env) {
  if (env.VAULT_KEY && String(env.VAULT_KEY).length >= 16) return enc.encode(env.VAULT_KEY);
  if (cached) return cached;
  let o = await env.RAW.get(KEY_OBJ);
  if (!o) { const k = crypto.getRandomValues(new Uint8Array(32)); await env.RAW.put(KEY_OBJ, k, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { uso: 'chave do cofre de credenciais', criada_em: new Date().toISOString() } }); o = await env.RAW.get(KEY_OBJ); }
  if (!o) throw Object.assign(new Error('Não foi possível preparar a chave do cofre.'), { status: 500 });
  cached = new Uint8Array(await o.arrayBuffer()); return cached;
}
async function key(env) {
  const raw = await crypto.subtle.digest('SHA-256', await material(env));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return 'v1:' + b64(out);
}
export async function open(env, sealed) {
  if (!sealed) return null;
  const u8 = unb64(String(sealed).replace(/^v1:/, ''));
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, await key(env), u8.slice(12)));
}
export async function sha256(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))), b => b.toString(16).padStart(2, '0')).join(''); }
