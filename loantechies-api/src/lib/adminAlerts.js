// Port of Admin/AdminApi.cs's console/rate-alerts and console/savings-alerts admin endpoints
// (Access-gated list + admin-initiated create). Migrated urgently alongside adminLeads.js — same
// stale-read gap: rate_alerts/savings_alerts write to D1 since the earlier Phase 3 push, but these
// list endpoints were still Azure-forwarded.
import { ok, badRequest, unauthorized, json, readJsonBody, toIso, clampInt, paginate } from './http.js';
import { requireAccess } from './auth.js';
import { createAlert as createRateAlertRow, programLabel as rateProgramLabel } from './rateAlert.js';
import { createAlert as createSavingsAlertRow, programLabel as savingsProgramLabel } from './savingsAlert.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function activeFilterOf(url) {
  const raw = (url.searchParams.get('active') || '').toLowerCase();
  return raw === 'true' ? true : raw === 'false' ? false : null;
}

// ---------- GET console/rate-alerts ----------

function toAlertDto(row) {
  return {
    id: row.id, email: row.email, term: row.term, refinance: !!row.refinance,
    targetRate: row.target_rate, active: !!row.active, lang: row.lang,
    programLabel: rateProgramLabel(row.term, !!row.refinance),
    createdUtc: toIso(row.created_at), notifiedUtc: toIso(row.notified_at),
  };
}

export async function listRateAlerts(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const activeFilter = activeFilterOf(url);

  const { results } = await env.DB.prepare('SELECT * FROM rate_alerts').all();
  let rows = (results || []).map(toAlertDto);
  if (activeFilter != null) rows = rows.filter((r) => r.active === activeFilter);
  if (q) rows = rows.filter((r) => (r.email || '').toLowerCase().includes(q));
  rows.sort((a, b) => (a.createdUtc < b.createdUtc ? 1 : a.createdUtc > b.createdUtc ? -1 : 0));

  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return ok(paginate(rows, page, pageSize));
}

// ---------- POST console/rate-alerts/create ----------
// Admin adds a rate alert on a borrower's behalf.

export async function createRateAlert(request, env) {
  const adminEmail = await requireAccess(request, env);
  if (!adminEmail) return unauthorized();

  const data = (await readJsonBody(request)) || {};
  const email = (data.email || '').trim();
  if (!email || !email.includes('@') || email.length > 254) return badRequest('A valid email is required.');
  const term = Number(data.term);
  if (![30, 15, 7, 5].includes(term)) return badRequest('Invalid loan program.');
  const targetRate = Number(data.targetRate);
  if (!(targetRate > 0) || targetRate > 25) return badRequest('Target rate must be between 0 and 25.');

  try {
    const { id, confirmationSent } = await createRateAlertRow(env, {
      email, term, refinance: !!data.refinance, targetRate, lang: data.lang,
      sendConfirmation: data.sendConfirmation != null ? !!data.sendConfirmation : true,
    });
    return ok({ ok: true, id, confirmationSent });
  } catch (e) {
    console.error(`AdminRateAlertCreate failed — ${e.message}`);
    return json({ error: 'Could not save the alert.' }, 500);
  }
}

// ---------- GET console/savings-alerts ----------

function toSavingsDto(row) {
  return {
    id: row.id, email: row.email, balance: row.balance, currentRate: row.current_rate,
    yearsLeft: row.years_left, term: row.term, targetSavings: row.target_savings,
    active: !!row.active, lang: row.lang, programLabel: savingsProgramLabel(row.term),
    createdUtc: toIso(row.created_at), notifiedUtc: toIso(row.notified_at),
  };
}

export async function listSavingsAlerts(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const activeFilter = activeFilterOf(url);

  const { results } = await env.DB.prepare('SELECT * FROM savings_alerts').all();
  let rows = (results || []).map(toSavingsDto);
  if (activeFilter != null) rows = rows.filter((r) => r.active === activeFilter);
  if (q) rows = rows.filter((r) => (r.email || '').toLowerCase().includes(q));
  rows.sort((a, b) => (a.createdUtc < b.createdUtc ? 1 : a.createdUtc > b.createdUtc ? -1 : 0));

  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return ok(paginate(rows, page, pageSize));
}

// ---------- POST console/savings-alerts/create ----------

export async function createSavingsAlert(request, env) {
  const adminEmail = await requireAccess(request, env);
  if (!adminEmail) return unauthorized();

  const data = (await readJsonBody(request)) || {};
  const email = (data.email || '').trim();
  if (!email || !email.includes('@') || email.length > 254) return badRequest('A valid email is required.');
  const balance = Number(data.balance);
  if (!(balance > 0) || balance > 100_000_000) return badRequest('Enter the current loan balance.');
  const currentRate = Number(data.currentRate);
  if (!(currentRate > 0) || currentRate > 25) return badRequest('Current rate must be between 0 and 25.');
  const yearsLeft = Number(data.yearsLeft);
  if (!(yearsLeft >= 1) || yearsLeft > 40) return badRequest('Years left must be between 1 and 40.');
  const term = Number(data.term);
  if (![30, 15, 7, 5].includes(term)) return badRequest('Invalid loan program.');
  const targetSavings = Number(data.targetSavings);
  if (!(targetSavings > 0) || targetSavings > 100_000) return badRequest('Target monthly savings must be greater than 0.');

  try {
    const { id, confirmationSent } = await createSavingsAlertRow(env, {
      email, balance, currentRate, yearsLeft, term, targetSavings, lang: data.lang,
      sendConfirmation: data.sendConfirmation != null ? !!data.sendConfirmation : true,
    });
    return ok({ ok: true, id, confirmationSent });
  } catch (e) {
    console.error(`AdminSavingsAlertCreate failed — ${e.message}`);
    return json({ error: 'Could not save the alert.' }, 500);
  }
}
