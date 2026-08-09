// Short-lived HMAC-signed URLs for R2-stored documents — replaces Azure Blob Storage's SAS URL
// (BlobStorageFactory.CreateReadSasUri in the C#). R2 has no first-party SAS-URL equivalent
// reachable purely via the R2 binding (no S3-API credentials needed), so this Worker mints its
// own signature instead: GET /documents?key=...&exp=...&sig=... , verified against
// DOCUMENT_SIGNING_SECRET, then streams the object back. The signed link itself IS the auth —
// admin.loantechies.com opens it with `window.open(url)`, same pattern as the SAS URL it replaces.
import { notFound } from './http.js';

async function hmacHex(env, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DOCUMENT_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mints a signed, time-limited URL for an R2 key. Mirrors AdminUploadFileUrl's 15-minute default.
export async function signDocumentUrl(env, key, ttlSeconds = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(env, `${key}:${exp}`);
  const origin = env.PUBLIC_SITE_ORIGIN || 'https://www.loantechies.com';
  const url = `${origin}/api/documents?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  return { url, expiresAt: exp };
}

async function verifySignature(env, key, exp, sig) {
  if (!key || !exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || Math.floor(Date.now() / 1000) >= expNum) return false;
  const expected = await hmacHex(env, `${key}:${expNum}`);
  return sig.length === expected.length && timingSafeEqual(expected, sig);
}

// ---------- GET /documents?key=&exp=&sig= (public — the signature IS the auth) ----------
export async function serveDocument(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');

  if (!(await verifySignature(env, key, exp, sig))) return new Response(null, { status: 403 });

  const obj = await env.DOCUMENTS.get(key);
  if (!obj) return notFound('File not found.');

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
}
