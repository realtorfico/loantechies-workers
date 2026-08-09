// Cloudflare Access JWT verification for admin (console/*) routes, plus Turnstile verification
// for public forms. Ported from SofticianApi's Utils/AccessAuth.cs — deliberately built on
// Workers' native crypto.subtle (RSASSA-PKCS1-v1_5 / SHA-256) rather than a JWT library, same
// reasoning as the C# original (no external dependency to conflict with anything). This is a
// closer port than examprep-api's src/lib/auth.js: it also checks issuer + alg, accepts the
// CF_Authorization cookie as a fallback (not just the header), and force-refreshes the JWKS once
// on a kid miss (keys rotate) — matching AccessAuth.ValidateAsync's exact behavior rather than a
// simplified subset.

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// "myteam", "myteam.cloudflareaccess.com", or a full URL -> "https://myteam.cloudflareaccess.com".
// Mirrors AccessAuth.NormalizeIssuer.
function normalizeIssuer(team) {
  if (!team) return null;
  team = team.trim();
  if (team.startsWith('http://') || team.startsWith('https://')) return team.replace(/\/+$/, '');
  if (team.includes('.cloudflareaccess.com')) return 'https://' + team.replace(/\/+$/, '');
  return `https://${team}.cloudflareaccess.com`;
}

// Cached for the isolate's lifetime; cold starts refetch. Keyed by issuer so multiple teams
// (shouldn't happen in practice, but matches the C# side's URL-keyed cache) don't collide.
const jwksCache = new Map();

async function getAccessJwks(issuer, forceRefresh) {
  if (!forceRefresh && jwksCache.has(issuer)) return jwksCache.get(issuer);
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  const json = await res.json();
  jwksCache.set(issuer, json);
  return json;
}

export async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true; // no-op until TURNSTILE_SECRET is configured, mirrors Utils/Security.cs
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json();
  return data.success === true;
}

// Full validation: reads Cf-Access-Jwt-Assertion (falling back to the CF_Authorization cookie,
// same precedence as AccessAuth.ValidateAsync), verifies the RS256 signature against Cloudflare's
// JWKS, then checks alg/issuer/audience/expiry/email-allowlist. Fails CLOSED — an unconfigured
// CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD rejects everything rather than opening up.
// Returns { ok: true, email } or { ok: false, error }.
export async function checkAccess(request, env) {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return { ok: false, error: 'Admin auth not configured.' };
  const issuer = normalizeIssuer(team);

  const headerTok = request.headers.get('Cf-Access-Jwt-Assertion');
  const cookieTok = (request.headers.get('Cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('CF_Authorization='))
    ?.slice('CF_Authorization='.length);
  const token = headerTok || cookieTok;
  if (!token) return { ok: false, error: 'Missing Access token.' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Malformed token.' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return { ok: false, error: 'Invalid Access token.' };
  }
  if (header.alg !== 'RS256') return { ok: false, error: 'Unsupported token algorithm.' };

  let jwks = await getAccessJwks(issuer, false);
  let jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await getAccessJwks(issuer, true); // keys rotate — force refresh once on a kid miss
    jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, error: 'Signing key not found.' };

  let valid;
  try {
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(sigB64), data);
  } catch {
    return { ok: false, error: 'Invalid Access token.' };
  }
  if (!valid) return { ok: false, error: 'Bad signature.' };

  const tokenIssuer = (payload.iss || '').replace(/\/+$/, '');
  if (tokenIssuer.toLowerCase() !== issuer.toLowerCase()) return { ok: false, error: 'Invalid issuer.' };

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, error: 'Invalid audience.' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return { ok: false, error: 'Token expired.' };

  const email = (payload.email || '').trim();
  if (!email) return { ok: false, error: 'No email claim.' };

  if (env.CF_ACCESS_ALLOWED_EMAILS) {
    const allowed = env.CF_ACCESS_ALLOWED_EMAILS.split(/[,; ]+/).filter(Boolean).map((e) => e.trim().toLowerCase());
    if (allowed.length > 0 && !allowed.includes(email.toLowerCase())) return { ok: false, error: 'Email not allowed.' };
  }

  return { ok: true, email };
}

// Convenience wrapper for route handlers: returns the verified email on success, or null (and
// logs the rejection reason) on failure — the route just needs to 401 on a null return.
export async function requireAccess(request, env) {
  const result = await checkAccess(request, env);
  if (!result.ok) {
    console.warn(`requireAccess: rejected — ${result.error}`);
    return null;
  }
  return result.email;
}

// Simple header/query-param shared-secret check for the LoanFactory/Provident/RocketPro rate
// ingest endpoints (machine-to-machine POSTs from the email-ingest Worker — no Access JWT
// available there). Mirrors the X-Webhook-Key check described in Admin/ExternalRates.cs.
export function requireIngestKey(request, expectedKey) {
  if (!expectedKey) return false; // fail closed if unconfigured
  const provided = request.headers.get('X-Webhook-Key') || new URL(request.url).searchParams.get('key');
  return provided === expectedKey;
}
