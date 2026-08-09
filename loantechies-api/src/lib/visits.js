// Port of Analytics/VisitTracker.cs — anonymous beacon (visits/track) + Access-gated admin
// dashboard (console/visits). Preserves: IP-based drop-at-write, upsert-by-session semantics
// (firstSeen preserved, duration only moves forward, leadId/ip/userAgent/pages fall back to the
// prior row when a later beacon omits them), name+location exclusion filtering with purge-on-read,
// and the MaxRetained=5000 rolling prune.
//
// IP extraction is simpler than the C# version: that code reached Azure directly and had to
// reconstruct the real client IP from X-Forwarded-For (with Azure's ":port" suffix stripped).
// Now that this Worker sits behind Cloudflare's own edge, CF-Connecting-IP is always the real
// client IP — no header-chain reconstruction needed.
import { loadExclusions, matchesIp, isExcludedVisit } from './visitExclusions.js';
import { ok, badRequest, nowSeconds } from './http.js';
import { requireAccess } from './auth.js';

const MAX_RETAINED = 5000;

function cap(s, max) {
  s = (s || '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Strip characters D1 doesn't need escaped but that Azure Table forbade in RowKeys — kept for
// parity so migrated + newly-written session ids look the same, and to keep ids URL/log-safe.
function sanitizeSessionId(s, max) {
  s = (s || '').trim();
  const clean = Array.from(s).filter((c) => c >= ' ' && !'/\\#?'.includes(c)).join('');
  return clean.length > max ? clean.slice(0, max) : clean;
}

// Drop blanks + consecutive dupes, cap each entry and the joined total. Falls back to the single
// current page when no list was sent.
function joinPages(pages, fallback) {
  const list = [];
  if (Array.isArray(pages)) {
    for (const p of pages) {
      const c = cap(p, 200);
      if (!c) continue;
      if (list.length === 0 || list[list.length - 1] !== c) list.push(c);
      if (list.length >= 60) break;
    }
  }
  if (list.length === 0 && fallback) list.push(cap(fallback, 200));
  const joined = list.join('\n');
  return joined.length > 6000 ? joined.slice(0, 6000) : joined;
}

// POST visits/track — anonymous
export async function trackVisit(request, env) {
  let b;
  try {
    const raw = await request.text();
    b = raw && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    b = null;
  }
  if (!b || !b.sessionId || !String(b.sessionId).trim()) return badRequest('Missing session.');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const exclusions = await loadExclusions(env);
  if (matchesIp(exclusions, ip)) return ok({ ok: true, skipped: true });

  const now = nowSeconds();
  const id = sanitizeSessionId(b.sessionId, 80);
  const durationMs = Number(b.durationMs) < 0 || !Number.isFinite(Number(b.durationMs)) ? 0 : Number(b.durationMs);

  let row = {
    id,
    first_seen_at: now,
    last_seen_at: now,
    duration_ms: durationMs,
    page: cap(b.page, 300),
    zip: cap(b.zip, 12),
    city: cap(b.city, 80),
    region: cap(b.region, 40),
    lead_id: cap(b.leadId, 64),
    lang: cap(b.lang, 5),
    referrer: cap(b.ref, 300),
    ip: cap(ip, 45),
    user_agent: cap(request.headers.get('User-Agent') || '', 400),
    pages: joinPages(b.pages, b.page),
  };

  const existing = await env.DB.prepare('SELECT * FROM visits WHERE id = ?').bind(id).first();
  if (existing) {
    row.first_seen_at = existing.first_seen_at;
    if (existing.duration_ms > row.duration_ms) row.duration_ms = existing.duration_ms;
    if (!row.lead_id && existing.lead_id) row.lead_id = existing.lead_id;
    if (!row.ip && existing.ip) row.ip = existing.ip;
    if (!row.user_agent && existing.user_agent) row.user_agent = existing.user_agent;
    if (!row.pages && existing.pages) row.pages = existing.pages;
  }

  await env.DB.prepare(
    `INSERT INTO visits (id, first_seen_at, last_seen_at, duration_ms, page, zip, city, region, lead_id, lang, referrer, ip, user_agent, pages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at, duration_ms=excluded.duration_ms,
       page=excluded.page, zip=excluded.zip, city=excluded.city, region=excluded.region, lead_id=excluded.lead_id,
       lang=excluded.lang, referrer=excluded.referrer, ip=excluded.ip, user_agent=excluded.user_agent, pages=excluded.pages`
  ).bind(row.id, row.first_seen_at, row.last_seen_at, row.duration_ms, row.page, row.zip, row.city, row.region,
         row.lead_id, row.lang, row.referrer, row.ip, row.user_agent, row.pages).run();

  return ok({ ok: true }); // body ignored by sendBeacon; useful for the fetch fallback
}

// Best-effort lead-name join. Until leads (Phase 3) is migrated, this D1 query simply finds
// nothing and every visit's leadName comes back null — a cosmetic gap, not a data-loss risk,
// since lead_id itself is still stored either way and backfills once leads lands.
async function resolveLeadNames(env, leadIds) {
  const map = {};
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, first_name, last_name, email, phone FROM leads WHERE id IN (${placeholders})`
  ).bind(...ids).all();
  for (const r of results || []) {
    let name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
    if (!name) name = r.email || r.phone || '';
    if (name) map[r.id] = name;
  }
  return map;
}

// GET console/visits?limit=100 — Access-gated
export async function listVisits(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) limit = 100;

  const { results } = await env.DB.prepare('SELECT * FROM visits ORDER BY last_seen_at DESC').all();
  let all = results || [];

  const names = await resolveLeadNames(env, all.map((v) => v.lead_id));
  const nameOf = (v) => (v.lead_id && names[v.lead_id]) || null;

  const exclusions = await loadExclusions(env);
  const excluded = all.filter((v) => isExcludedVisit(exclusions, v.ip, nameOf(v), v.city, v.region));
  if (excluded.length > 0) {
    const stmt = env.DB.prepare('DELETE FROM visits WHERE id = ?');
    await env.DB.batch(excluded.map((v) => stmt.bind(v.id)));
    const drop = new Set(excluded.map((v) => v.id));
    all = all.filter((v) => !drop.has(v.id));
  }

  if (all.length > MAX_RETAINED) {
    const toPrune = all.slice(MAX_RETAINED); // already sorted newest-first
    const stmt = env.DB.prepare('DELETE FROM visits WHERE id = ?');
    await env.DB.batch(toPrune.map((v) => stmt.bind(v.id)));
    all = all.slice(0, MAX_RETAINED);
  }

  const now = nowSeconds();
  const zipCounts = {};
  for (const v of all) {
    if (!v.zip) continue;
    zipCounts[v.zip] = (zipCounts[v.zip] || 0) + 1;
  }
  const topZips = Object.entries(zipCounts)
    .map(([zip, count]) => ({ zip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const summary = {
    total: all.length,
    last24h: all.filter((v) => now - v.last_seen_at <= 24 * 3600).length,
    last7d: all.filter((v) => now - v.last_seen_at <= 7 * 24 * 3600).length,
    withLead: all.filter((v) => v.lead_id).length,
    topZips,
  };

  const visits = all.slice(0, limit).map((v) => ({
    sessionId: v.id,
    firstSeenUtc: v.first_seen_at,
    lastSeenUtc: v.last_seen_at,
    durationMs: v.duration_ms,
    page: v.page,
    pages: v.pages ? v.pages.split('\n') : [],
    zip: v.zip,
    city: v.city,
    region: v.region,
    ip: v.ip,
    userAgent: v.user_agent,
    lang: v.lang,
    referrer: v.referrer,
    leadId: v.lead_id,
    leadName: nameOf(v),
  }));

  return ok({ summary, visits });
}
