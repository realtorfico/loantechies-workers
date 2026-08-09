// Port of Admin/ExternalRates.cs (LoanFactory/RocketPro) + Admin/ProvidentRates.cs (Provident) —
// both share one `external_rates` D1 table (source, id) exactly like they share the Azure
// "ExternalRates" table (PartitionKey=source). Ingest is machine-to-machine (X-Webhook-Key), not
// Cloudflare Access — see requireIngestKey() in auth.js.
//
// Scope: storage/CRUD only (ingest, admin list, public latest for LoanFactory/RocketPro).
// console/rates/provident/advertised is deliberately NOT ported here — it needs
// ProvidentPricing.Derive() + RegZApr, which land with the Phase 2 pricing engine. Until then it
// stays on the Azure-forward path.
import { ok, badRequest, notFound, serviceUnavailable, readJsonBody, nowSeconds, toIso } from './http.js';
import { requireAccess, requireIngestKey } from './auth.js';

const KNOWN_LOANFACTORY_SOURCES = new Set(['loanfactory', 'rocketpro']);

// yyyy-MM-dd in the client's stated zone, taken exactly as parsed (no UTC reinterpretation) —
// mirrors the C# side's deliberate avoidance of DateTime.ToUniversalTime() on an Unspecified-kind
// parsed date. The Workers runtime has no local-timezone concept beyond UTC, so UTC getters here
// are equivalent to "no shift."
function parseDateOnly(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "Today" in Pacific time — see loantechies-pacific-timezone-rule: staleness/date-fallback
// comparisons must use Pacific, not naive UTC, since the business (and these emails) run PT.
function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function pruneOld90d(env) {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const cutoffStr = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}`;
  // No source filter — prune across every source, matching the C# side's full-table sweep.
  await env.DB.prepare('DELETE FROM external_rates WHERE id < ?').bind(cutoffStr).run();
}

// ---------------- LoanFactory / RocketPro ----------------

// POST console/rates/loanfactory/ingest — machine key (LOANFACTORY_INGEST_KEY)
export async function ingestLoanFactory(request, env) {
  if (!requireIngestKey(request, env.LOANFACTORY_INGEST_KEY)) return new Response(null, { status: 401 });

  const rawBody = await request.text();
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return badRequest('Invalid JSON.');
  }
  if (!payload || (!payload.conventional && !payload.nonQm)) return badRequest('No rate data in payload.');

  const source = (payload.source || 'loanfactory').trim().toLowerCase();
  if (!KNOWN_LOANFACTORY_SOURCES.has(source)) return badRequest(`Unknown source '${source}'.`);

  const rowId = parseDateOnly(payload.emailDate) || pacificToday();

  await env.DB.prepare(
    `INSERT INTO external_rates (source, id, scenario, email_date, posted_date, json, saved_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(source, id) DO UPDATE SET
       scenario=excluded.scenario, email_date=excluded.email_date, json=excluded.json, saved_at=excluded.saved_at`
  ).bind(source, rowId, payload.scenario || '', payload.emailDate || '', rawBody, nowSeconds()).run();

  await pruneOld90d(env);
  return ok({ ok: true, date: rowId });
}

// GET console/rates/loanfactory?limit=7&source=loanfactory — Access-gated
export async function getLoanFactorySnapshots(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit)) limit = 7;
  limit = Math.min(Math.max(limit, 1), 90);
  const source = (url.searchParams.get('source') || 'loanfactory').trim().toLowerCase();

  const { results } = await env.DB.prepare(
    'SELECT id, scenario, email_date, saved_at, json FROM external_rates WHERE source = ? ORDER BY id DESC LIMIT ?'
  ).bind(source, limit).all();

  const snapshots = (results || []).map((r) => ({
    date: r.id,
    scenario: r.scenario,
    emailDate: r.email_date,
    savedUtc: toIso(r.saved_at),
    rates: r.json ? JSON.parse(r.json) : null,
  }));
  return ok({ snapshots });
}

// GET rates/loanfactory/latest?source=loanfactory — anonymous
export async function getLoanFactoryLatest(request, env) {
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'loanfactory').trim().toLowerCase();

  const row = await env.DB.prepare(
    'SELECT id, scenario, email_date, saved_at, json FROM external_rates WHERE source = ? ORDER BY id DESC LIMIT 1'
  ).bind(source).first();

  if (!row) return notFound('No rates available yet.');
  return ok({
    date: row.id,
    scenario: row.scenario,
    emailDate: row.email_date,
    savedUtc: toIso(row.saved_at),
    rates: row.json ? JSON.parse(row.json) : null,
  });
}

// ---------------- Provident ----------------

// POST console/rates/provident/ingest — machine key (PROVIDENT_INGEST_KEY)
export async function ingestProvident(request, env) {
  if (!requireIngestKey(request, env.PROVIDENT_INGEST_KEY)) return new Response(null, { status: 401 });

  const rawBody = await request.text();
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return badRequest('Invalid JSON.');
  }
  if (!payload?.grids || Object.keys(payload.grids).length === 0) return badRequest('No rate grid in payload.');

  const rowId = parseDateOnly(payload.postedDate) || pacificToday();

  await env.DB.prepare(
    `INSERT INTO external_rates (source, id, scenario, email_date, posted_date, json, saved_at)
     VALUES ('provident', ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(source, id) DO UPDATE SET
       posted_date=excluded.posted_date, json=excluded.json, saved_at=excluded.saved_at`
  ).bind(rowId, payload.postedDate || '', rawBody, nowSeconds()).run();

  await pruneOld90d(env);
  return ok({ ok: true, date: rowId, products: Object.keys(payload.grids) });
}

// GET console/rates/provident?limit=7 — Access-gated, no public equivalent
export async function getProvidentSnapshots(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit)) limit = 7;
  limit = Math.min(Math.max(limit, 1), 90);

  const { results } = await env.DB.prepare(
    "SELECT id, posted_date, saved_at, json FROM external_rates WHERE source = 'provident' ORDER BY id DESC LIMIT ?"
  ).bind(limit).all();

  const snapshots = (results || []).map((r) => ({
    date: r.id,
    postedDate: r.posted_date,
    savedUtc: toIso(r.saved_at),
    grid: r.json ? JSON.parse(r.json) : null,
  }));
  return ok({ snapshots });
}
