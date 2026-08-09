// Port of Loans/ZillowCurrentRatesProvider.cs — Zillow getCurrentRates, returning all 8 program
// rates (4 programs x purchase/refi) in one call, parameterized by credit-score bucket and LTV
// bucket. Zillow prices credit/LTV risk directly into the rate, so no LLPA approximation is
// layered on top for this source.
//
// Caching: simplified vs the C# original. That version's stale-while-revalidate (serve stale +
// background Task.Run refresh) existed because it's a long-lived, always-warm process — a
// per-instance cache genuinely stays populated for hours. A Workers isolate's lifetime is shorter
// and less predictable, so this port uses a plain per-isolate TTL cache (serve fresh within TTL,
// otherwise do a synchronous refetch) — no stale-serving, no background refresh. Worst case is an
// occasional extra Zillow round-trip on the request path, never stale or incorrect data.
import { fallbackFor, checkConventionalRefiGuardrails } from './rateConfig.js';
import { shouldAlert } from './alertCooldown.js';
import { businessInbox, sendViaResend } from './emailer.js';

const BASE_URL = 'https://mortgageapi.zillow.com/getCurrentRates';
const PROPERTY_VALUE = 900_000;
const SOFT_TTL_MS = 2 * 3600 * 1000; // 2 hours
const GUARDRAIL_ALERT_COOLDOWN_MINUTES = 6 * 60;

const cache = new Map(); // cacheKey -> { rates, expiresAtMs }

// ---- Public bucket-mapping helpers ----

export function toCreditBucket(creditLabel) {
  switch (creditLabel || '') {
    case '780+':
    case '760-779':
    case '740-759':
      return 'VeryHigh';
    case '720-739':
    case '700-719':
    case '680-699':
    case 'Not sure':
      return 'High';
    default:
      return 'Low';
  }
}

export function toLtvBucket(ltv) {
  if (ltv < 80.0) return 'Normal';
  if (ltv < 95.0) return 'High';
  return 'VeryHigh';
}

export function ltvBucketLoanAmount(ltvBucket) {
  if (ltvBucket === 'High') return 765_000; // 765/900 ~ 85%
  if (ltvBucket === 'VeryHigh') return 855_000; // 855/900 ~ 95%
  return 700_000; // 700/900 ~ 78%
}

// ---- Primary entry point ----

// Returns { rate, apr, source } for one program. Falls back to the config fallback rate when
// Zillow is unavailable.
export async function getRate(creditBucket, ltvBucket, term, refinance, cfg, env) {
  const isArmProduct = term === 5 || term === 7;

  // Low-credit ARM rates from Zillow are unreliable (purchase returns 0; refi ARM rates invert —
  // see class doc comment). The config fallback is conservative and honest for this segment.
  if (creditBucket === 'Low' && isArmProduct) {
    const fb = fallbackFor(cfg, term);
    return { rate: fb, apr: fb, source: 'config-fallback' };
  }

  try {
    const rates = await getAllRates(creditBucket, ltvBucket, env);
    if (rates) {
      const idx = indexKey(term, refinance);
      const r = rates[idx];
      if (r && r.rate > 0) return { rate: r.rate, apr: r.apr > 0 ? r.apr : r.rate, source: 'zillow-current' };
    }
  } catch (e) {
    console.warn(`ZillowCurrentRatesProvider: fetch failed — ${e.message}`);
  }

  const fallback = fallbackFor(cfg, term);
  return { rate: fallback, apr: fallback, source: 'config-fallback' };
}

// ---- Cache-backed fetch ----

// Returns all 8 rates for the bucket combination, or null if Zillow fails and no cache exists.
export async function getAllRates(creditBucket, ltvBucket, env) {
  const cacheKey = `${creditBucket}:${ltvBucket}`;
  const now = Date.now();

  const entry = cache.get(cacheKey);
  if (entry && now < entry.expiresAtMs) return entry.rates;

  return fetchAndCache(creditBucket, ltvBucket, cacheKey, env, entry);
}

async function fetchAndCache(creditBucket, ltvBucket, cacheKey, env, staleEntry) {
  const partnerId = env.ZILLOW_PARTNER_ID || 'RD-WTMDTZN';
  const zip = env.ZILLOW_DEFAULT_ZIP || '95377';
  const loanAmount = ltvBucketLoanAmount(ltvBucket);
  const url = buildUrl(partnerId, zip, creditBucket, loanAmount);

  try {
    const res = await fetch(url);
    const body = await res.text();
    const rates = parseRates(body);
    if (rates) cache.set(cacheKey, { rates, expiresAtMs: Date.now() + SOFT_TTL_MS });
    return rates;
  } catch (e) {
    console.warn(`ZillowCurrentRatesProvider: ${cacheKey} fetch failed — ${e.message}`);
    return staleEntry ? staleEntry.rates : null; // serve stale on fetch failure if we have it
  }
}

// ---- Alert-only guardrail check ----

// Fire-and-forget: fetches VeryHigh+Normal rates (cached), checks against the configured
// guardrail bands, and emails the business inbox if violated. 6-hour cooldown. Caller does not
// await this (matches CheckAndAlertGuardrails's fire-and-forget contract).
export function checkAndAlertGuardrails(cfg, env) {
  (async () => {
    try {
      const rates = await getAllRates('VeryHigh', 'Normal', env);
      if (!rates) return;

      const r = (idx) => (rates[idx] && rates[idx].rate > 0 ? rates[idx].rate : null);
      const violations = checkConventionalRefiGuardrails(cfg?.refiGuardrails, r('11'), r('4'), r('14'));
      if (violations.length === 0) return;

      if (!(await shouldAlert(env, 'zillow-refi-guardrail', GUARDRAIL_ALERT_COOLDOWN_MINUTES))) return;

      const to = businessInbox(env);
      if (!to) return;

      const body = `Zillow getCurrentRates guardrail check flagged ${violations.length} violation(s):\n\n` +
        violations.map((v) => `  - ${v}`).join('\n\n') +
        '\n\nThis is alert-only — the live Zillow rates are still being served to borrowers.';
      await sendViaResend(env, to, '⚠️ Zillow refi rate guardrail alert', body);
    } catch (e) {
      console.warn(`ZillowCurrentRatesProvider.checkAndAlertGuardrails failed — ${e.message}`);
    }
  })();
}

// ---- URL builder ----

export function buildUrl(partnerId, zip, creditBucket, loanAmount) {
  let s = `${BASE_URL}?partnerId=${encodeURIComponent(partnerId)}`;
  s += appendQuery(1, zip, loanAmount, PROPERTY_VALUE, creditBucket, false, 'Fixed30Year');
  s += appendQuery(2, zip, loanAmount, PROPERTY_VALUE, creditBucket, false, 'ARM7');
  s += appendQuery(3, zip, loanAmount, PROPERTY_VALUE, creditBucket, false, 'ARM5');
  s += appendQuery(4, zip, loanAmount, PROPERTY_VALUE, creditBucket, false, 'Fixed15Year');
  s += appendQuery(11, zip, loanAmount, PROPERTY_VALUE, creditBucket, true, 'Fixed30Year');
  s += appendQuery(12, zip, loanAmount, PROPERTY_VALUE, creditBucket, true, 'ARM7');
  s += appendQuery(13, zip, loanAmount, PROPERTY_VALUE, creditBucket, true, 'ARM5');
  s += appendQuery(14, zip, loanAmount, PROPERTY_VALUE, creditBucket, true, 'Fixed15Year');
  return s;
}

function appendQuery(n, zip, loanAmount, propertyValue, creditBucket, refi, program) {
  let s = `&queries.${n}.propertyBucket.location.zipCode=${zip}`;
  s += `&queries.${n}.propertyBucket.propertyValue=${propertyValue}`;
  s += `&queries.${n}.propertyBucket.loanAmount=${loanAmount}`;
  s += `&queries.${n}.creditScoreBucket=${creditBucket}`;
  if (refi) s += `&queries.${n}.refinance=true`;
  s += `&queries.${n}.program=${program}`;
  return s;
}

// ---- Response parser ----

export function parseRates(body) {
  try {
    const parsed = JSON.parse(body);
    const ratesNode = parsed?.rates;
    if (!ratesNode || typeof ratesNode !== 'object') return null;
    const result = {};
    for (const [name, val] of Object.entries(ratesNode)) {
      result[name] = { rate: Number(val?.rate) || 0, apr: Number(val?.apr) || 0 };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ---- Index key mapping ----

// Maps (term, refinance) to the Zillow query index string ("1"-"4", "11"-"14").
export function indexKey(term, refinance) {
  const idx = term === 7 ? 2 : term === 5 ? 3 : term === 15 ? 4 : 1;
  return String(refinance ? idx + 10 : idx);
}
