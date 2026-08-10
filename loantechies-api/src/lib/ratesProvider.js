// Port of Loans/RatesProvider.cs — GET/POST loans/ratesprovider, the historical rate-chart data
// feed behind the /rates page (Week/Month/Year/Decade ranges). Proxies + caches Zillow's
// getRates (historical samples) endpoint, bucketed by duration/program.
//
// Caching: simplified vs the C#'s stale-while-revalidate (serve-stale + deduped background
// Task.Run refresh, soft+hard dual expiry) — same reasoning as zillowCurrentRatesProvider.js's own
// doc comment: that design existed because the C# was a long-lived, always-warm process where a
// per-instance cache genuinely stayed populated for hours. A Workers isolate's lifetime is shorter
// and less predictable, so this port uses a plain per-isolate TTL cache (serve fresh within TTL,
// otherwise a synchronous refetch) — no stale-serving, no background refresh, no cache-warming
// cron (nothing to warm once there's no stale-while-revalidate tier to keep ahead of). Worst case
// is an occasional extra Zillow round-trip on the request path, never stale or incorrect data.
//
// ParseLatestSample is NOT ported — confirmed dead code even in the C# (RateAlert/SavingsAlert's
// actual evaluation path calls LoanFactoryRatesProvider/ZillowCurrentRatesProvider instead; see
// rateAlert.js's own module history).
import { badRequest, readJsonBody } from './http.js';

function zillowUrl(env) {
  return 'https://mortgageapi.zillow.com/getRates?partnerId=' + (env.ZILLOW_PARTNER_ID || 'RD-WTMDTZN');
}

const cache = new Map(); // reqUrl -> { json, expiresAtMs }

// Bucket the duration, build the Zillow URL, and return cached-or-fetched JSON plus whether it
// came from cache.
export async function getRatesJson(env, durationDays, refinance, term) {
  const statePortion = '&queries.1.stateAbbreviation=CA';
  const refinancePortion = refinance ? '&queries.1.refinance=true' : '';
  const termPortion = term === 15 ? '&queries.1.program=Fixed15Year'
    : term === 7 ? '&queries.1.program=ARM7'
    : term === 5 ? '&queries.1.program=ARM5'
    : term === 3 ? '&queries.1.program=ARM3' : '';

  let bucketDays, aggregation, ttlMs;
  if (durationDays <= 2) { bucketDays = 2; aggregation = ''; ttlMs = 3600 * 1000; }
  else if (durationDays <= 7) { bucketDays = 7; aggregation = ''; ttlMs = 86400 * 1000; }
  else if (durationDays <= 21) { bucketDays = 21; aggregation = ''; ttlMs = 86400 * 1000; }
  else if (durationDays <= 200) { bucketDays = 200; aggregation = 'Daily'; ttlMs = 30 * 86400 * 1000; }
  else if (durationDays <= 800) { bucketDays = 800; aggregation = 'Weekly'; ttlMs = 30 * 86400 * 1000; }
  else if (durationDays <= 2000) { bucketDays = 2000; aggregation = 'Weekly'; ttlMs = 30 * 86400 * 1000; }
  else { bucketDays = 4000; aggregation = 'Monthly'; ttlMs = 30 * 86400 * 1000; }

  const aggPortion = aggregation ? `&aggregation=${aggregation}` : '';
  const reqUrl = `${zillowUrl(env)}${statePortion}${refinancePortion}${termPortion}&durationDays=${bucketDays}${aggPortion}`;

  const hit = cache.get(reqUrl);
  if (hit && Date.now() < hit.expiresAtMs) return { json: hit.json, fromCache: true };

  const res = await fetch(reqUrl);
  if (!res.ok) throw new Error(`Zillow getRates HTTP ${res.status}`);
  const json = await res.text();
  cache.set(reqUrl, { json, expiresAtMs: Date.now() + ttlMs });
  return { json, fromCache: false };
}

export async function ratesProvider(request, env) {
  const url = new URL(request.url);
  let durationDaysStr = url.searchParams.get('durationDays');
  let refinanceStr = url.searchParams.get('refinance');
  const termStr = url.searchParams.get('term');

  if (durationDaysStr == null) {
    const body = await readJsonBody(request);
    if (body?.durationDays != null) durationDaysStr = String(body.durationDays);
    if (refinanceStr == null && body?.refinance != null) refinanceStr = String(body.refinance);
  }

  const refinance = (refinanceStr || '').toLowerCase() === 'true';
  const durationDays = parseInt(durationDaysStr, 10);
  const term = parseInt(termStr, 10);
  if (!Number.isFinite(durationDays) || !Number.isFinite(term))
    return badRequest('durationDays and term must be integers.');

  let json, fromCache;
  try {
    ({ json, fromCache } = await getRatesJson(env, durationDays, refinance, term));
  } catch (e) {
    console.error(`RatesProvider fetch failed: ${e.message}`);
    return new Response(JSON.stringify({ error: 'Rate provider is temporarily unavailable.' }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }

  const isHourCached = durationDays <= 2 && fromCache;
  const isDayCached = durationDays > 2 && durationDays <= 21 && fromCache;
  const isMonthCached = durationDays > 21 && fromCache;

  return new Response(JSON.stringify({ json, isMonthCached, isDayCached, isHourCached }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
