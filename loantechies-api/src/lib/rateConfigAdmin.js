// Port of Admin/AdminApi.cs's rate-config admin endpoints (console/rate-config*) — Access-gated
// CRUD + preview for the estimated-rate config. Deliberately migrated ALONGSIDE loans/estimatedrate
// (estimatedRate.js) in the same push, not before/after it — splitting the read path (D1) from the
// write path (would-be-still-Azure) would let admin edits silently stop taking effect.
//
// History response fields are simplified vs the C#'s (which also tracked 5 now-dead columns —
// RateOffset/OffsetPurchase/OffsetRefinance/OccInvestment/OccSecondHome — see rateConfig.js's
// module doc comment for why those were dropped). rate_config_history stores the full config
// snapshot as JSON (not fixed columns), so this reads out only the fields that still matter.
import { ok, badRequest, notFound } from './http.js';
import { requireAccess } from './auth.js';
import { readOrSeedAsync, saveAsync, readHistoryAsync, loadAsync as loadRateConfig } from './rateConfigStore.js';
import {
  defaults, validate, builderMeta, evaluateEligibility, computeLlpaDelta, computeGovAdj, computeCltvAdj,
  CURRENT_GUARDRAIL_VERSION,
} from './rateConfig.js';
import { getQuote } from './loanFactoryRatesProvider.js';
import { roundHalfEven } from './mathRound.js';

function round(v, dp = 4) {
  return roundHalfEven(v, dp);
}

// GET console/rate-config — seeds defaults on first read so a single page visit makes the
// estimate endpoint live.
export async function getRateConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const snap = await readOrSeedAsync(env, email);
  return ok({
    config: snap.config,
    version: snap.version,
    updatedUtc: snap.updatedUtc,
    updatedBy: snap.updatedBy,
    seeded: snap.seeded,
    meta: builderMeta(),
  });
}

// GET console/rate-config/defaults — factory defaults (not persisted), powers "Restore defaults".
export async function getRateConfigDefaults(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });
  return ok({ config: defaults(), meta: builderMeta() });
}

// POST console/rate-config/save — validates and persists. 400 on validation errors (never
// stored), 409 on a version conflict.
export async function saveRateConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  let body;
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!body?.config) return badRequest_array(['body: missing or invalid JSON (expected { config, version }).']);

  // The admin UI never sends refiGuardrails.version (it only posts the band numbers) — an
  // explicit admin save is by definition current, so stamp it here. Without this, a future load
  // would see version 0 < CURRENT_GUARDRAIL_VERSION and silently overwrite the admin's saved
  // bands back to the hardcoded defaults.
  if (body.config.refiGuardrails) body.config.refiGuardrails.version = CURRENT_GUARDRAIL_VERSION;

  const errors = validate(body.config);
  if (errors.length > 0) return badRequest_array(errors);

  const result = await saveAsync(env, body.config, email, body.version);
  if (result.status === 'conflict') {
    return json409({ error: 'The settings were changed by someone else. Reload and re-apply your edits.', currentVersion: result.currentVersion });
  }
  if (result.status === 'error') return new Response(JSON.stringify({ error: 'Could not save configuration.' }), { status: 503, headers: { 'content-type': 'application/json' } });

  return ok({ config: body.config, version: result.version, updatedUtc: result.updatedUtc, updatedBy: result.updatedBy });
}

function badRequest_array(errors) {
  return new Response(JSON.stringify({ errors }), { status: 400, headers: { 'content-type': 'application/json' } });
}
function json409(data) {
  return new Response(JSON.stringify(data), { status: 409, headers: { 'content-type': 'application/json' } });
}

// GET console/rate-config/history[?format=csv] — the value trail (newest first).
export async function getRateConfigHistory(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const hist = await readHistoryAsync(env);
  const url = new URL(request.url);

  const rows = hist.map((h) => ({
    version: h.version,
    updatedUtc: h.updatedUtc,
    updatedBy: h.updatedBy,
    anchorCreditScore: round(h.config?.anchorCreditScore ?? 0),
    anchorLtv: round(h.config?.anchorLtv ?? 0),
    deltaRefi30AddOn: round(h.config?.deltaRefi30AddOn ?? 0),
    deltaInvSecondHomeRefi30AddOn: round(h.config?.deltaInvSecondHomeRefi30AddOn ?? 0),
    cltvAmount: round(h.config?.cltvSurcharge?.amount ?? 0),
  }));

  if ((url.searchParams.get('format') || '').toLowerCase() === 'csv') {
    const header = 'Version,Updated (UTC),Updated By,Anchor Credit Score,Anchor LTV %,Refi-30F Delta (%),Inv/2nd-Home Refi-30F Delta (%),CLTV surcharge %\n';
    const body = rows.map((r) =>
      `${r.version},${new Date(r.updatedUtc * 1000).toISOString()},${csvCell(r.updatedBy)},${r.anchorCreditScore},${r.anchorLtv},${r.deltaRefi30AddOn},${r.deltaInvSecondHomeRefi30AddOn},${r.cltvAmount}\n`
    ).join('');
    const csv = '﻿' + header + body; // BOM -> Excel reads UTF-8
    const filename = `rate-config-history-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${filename}"` } });
  }

  return ok({ items: rows });
}

function csvCell(s) {
  s = s || '';
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET console/rate-config/base-rates — current par rates straight from the LoanFactory chain,
// before any credit/LTV or CLTV adjustment.
const BASE_RATE_COMBOS = [
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 30, refinance: false, label: 'Conventional · Primary · Purchase · 30-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 30, refinance: true, label: 'Conventional · Primary · Refinance · 30-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 15, refinance: false, label: 'Conventional · Primary · Purchase · 15-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 15, refinance: true, label: 'Conventional · Primary · Refinance · 15-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Investment Property', term: 30, refinance: false, label: 'Conventional · Investment · Purchase · 30-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Investment Property', term: 30, refinance: true, label: 'Conventional · Investment · Refinance · 30-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Second Home', term: 30, refinance: false, label: 'Conventional · Second Home · Purchase · 30-Yr Fixed' },
  { loanType: 'Conventional', occupancy: 'Second Home', term: 30, refinance: true, label: 'Conventional · Second Home · Refinance · 30-Yr Fixed' },
  { loanType: 'FHA', occupancy: 'Primary Residence', term: 30, refinance: false, label: 'FHA · Primary · Purchase · 30-Yr Fixed' },
  { loanType: 'VA', occupancy: 'Primary Residence', term: 30, refinance: false, label: 'VA · Primary · Purchase · 30-Yr Fixed' },
];

export async function getRateConfigBaseRates(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const cfg = (await loadRateConfig(env)) || defaults();
  const items = [];
  for (const c of BASE_RATE_COMBOS) {
    try {
      const quote = await getQuote(c.loanType, c.occupancy, c.term, c.refinance, cfg, env);
      items.push({
        product: c.label, loanType: c.loanType, occupancy: c.occupancy, term: c.term, refinance: c.refinance,
        available: quote.available, rate: round(quote.rate, 3), apr: quote.apr != null ? round(quote.apr, 3) : null,
        source: quote.source, snapshotDate: quote.snapshotDate,
      });
    } catch (e) {
      console.warn(`base-rates fetch failed (${c.label}): ${e.message}`);
      items.push({ product: c.label, loanType: c.loanType, occupancy: c.occupancy, term: c.term, refinance: c.refinance, available: false });
    }
  }
  return ok({ items, fetchedUtc: new Date().toISOString() });
}

// POST console/rate-config/preview — runs eligibility + delta math against a DRAFT (unsaved)
// config so the admin can test a scenario before saving. Fetches the live market rate but not a
// fresh quote source beyond what getQuote already does.
export async function previewRateConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  let body;
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  const cfg = body?.config || (await loadRateConfig(env));
  const sc = body?.scenario;
  if (!cfg || !sc) return badRequest('body: expected { config, scenario }.');

  const ltv = sc.ltv;
  const cltv = sc.cltv > 0 ? sc.cltv : ltv;
  const occupancy = (sc.occupancy || '').trim() || 'Primary Residence';
  const loanType = (sc.loanType || '').trim() || 'Conventional';

  const reason = evaluateEligibility(cfg, {
    creditLabel: sc.credit, ltv, cltv, occupancy, loanType, term: sc.term, refinance: !!sc.refinance,
  });
  if (reason != null) return ok({ eligible: false, message: reason });

  const creditForLookup = sc.credit === 'Not sure' ? '640-659' : sc.credit;
  const llpaDelta = computeLlpaDelta(cfg, creditForLookup, ltv, loanType);
  const govAdj = computeGovAdj(cfg, creditForLookup, ltv, loanType);
  const cltvAdj = computeCltvAdj(cfg, ltv, cltv);

  const quote = await getQuote(loanType, occupancy, sc.term, !!sc.refinance, cfg, env);
  const creditLtvAdj = llpaDelta + govAdj;
  const totalDelta = round(quote.rate + creditLtvAdj + cltvAdj) - quote.rate;

  return ok({
    eligible: true,
    isEstimated: sc.credit === 'Not sure' ? true : null,
    marketRate: round(quote.rate),
    marketApr: quote.apr != null ? round(quote.apr) : null,
    rateSource: quote.source,
    rateOffset: 0.0,
    llpaDelta: round(llpaDelta),
    govAdj: round(govAdj),
    occupancyAdj: 0.0,
    cltvAdj: round(cltvAdj),
    totalDelta,
  });
}
