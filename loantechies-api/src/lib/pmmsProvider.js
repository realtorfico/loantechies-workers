// Port of Loans/PmmsProvider.cs — Freddie Mac PMMS weekly averages from FRED, used as a reference
// benchmark for the rates diagnostic endpoint (never a pricing source). Two transports tried in
// order (API with a key, else keyless CSV), whichever yields a value first wins; on live-fetch
// failure, falls back to the last-good cached value as long as it's still recent (PMMS is weekly,
// so a cache miss isn't the same as "no benchmark").
import { loadPmms, savePmms } from './pmmsCache.js';
import { nowSeconds } from './http.js';

const SERIES_30 = 'MORTGAGE30US';
const SERIES_15 = 'MORTGAGE15US';
const MAX_CACHE_AGE_DAYS = 14;
const FETCH_TIMEOUT_MS = 6000;

// FRED's CDN 403s/ignores requests with no User-Agent.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/csv,*/*',
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: HEADERS, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Latest real observation from a FRED API JSON payload. FRED writes "." for a missing value.
export function latestApiValue(json) {
  try {
    const obs = JSON.parse(json)?.observations;
    if (!Array.isArray(obs)) return null;
    for (const o of obs) {
      const s = o?.value != null ? String(o.value) : '';
      if (!s.trim() || s === '.') continue;
      const v = Number(s);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}

// Latest real observation from a FRED CSV (header + "date,value" rows, oldest -> newest). Scans
// from the bottom up.
export function latestValue(csv) {
  if (!csv || !csv.trim()) return null;
  const lines = csv.replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 1; i--) { // row 0 is the header
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const raw = parts[parts.length - 1].trim();
    if (!raw || raw === '.') continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// One transport attempt: returns { val, err } — never throws.
async function tryOne(tag, url, isJson) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`PmmsProvider: FRED ${tag} returned ${res.status} for ${url}`);
      return { val: null, err: `${tag} HTTP ${res.status}` };
    }
    const body = await res.text();
    const v = isJson ? latestApiValue(body) : latestValue(body);
    if (v == null) console.warn(`PmmsProvider: no usable PMMS value (${tag}).`);
    return { val: v, err: v == null ? `${tag} no value` : null };
  } catch (e) {
    console.warn(`PmmsProvider: FRED ${tag} fetch failed — ${e.message}`);
    return { val: null, err: `${tag} ${e.name}` };
  }
}

async function fetchTerm(term, series, apiKey) {
  const attempts = [];
  if (apiKey && apiKey.trim())
    attempts.push(['API', `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=8`, true]);
  attempts.push(['CSV', `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`, false]);

  const errs = [];
  for (const [tag, url, isJson] of attempts) {
    const { val, err } = await tryOne(tag, url, isJson);
    if (val != null && val > 0) return { term, val, err: null };
    if (err) errs.push(err);
  }
  return { term, val: null, err: errs.length > 0 ? errs.join(' / ') : null };
}

// Latest PMMS weekly average by term (30, 15), plus a short diagnostic string (null on full
// success) so a failure's reason is visible on the admin dashboard.
export async function getLatest(env) {
  const apiKey = env.FRED_API_KEY;
  const now = nowSeconds();

  const results = await Promise.all([fetchTerm(30, SERIES_30, apiKey), fetchTerm(15, SERIES_15, apiKey)]);

  const map = {};
  const liveErrs = [];
  const staleNotes = [];

  for (const { term, val, err } of results) {
    if (val != null && val > 0) {
      map[term] = val;
      await savePmms(env, term, val, now);
      continue;
    }

    if (err) liveErrs.push(`${term}yr ${err}`);
    const cached = await loadPmms(env, term);
    if (cached) {
      const ageDays = (now - cached.fetchedUtc) / 86400;
      if (ageDays <= MAX_CACHE_AGE_DAYS) {
        map[term] = cached.value;
        console.log(`PmmsProvider: live FRED fetch failed for ${term}yr; using cached PMMS ${cached.value}% (${Math.round(ageDays)}d old).`);
      } else {
        staleNotes.push(`${term}yr only cached value is ${Math.round(ageDays)}d old (> ${MAX_CACHE_AGE_DAYS}d)`);
      }
    }
  }

  if (Object.keys(map).length >= 2) return { rates: map, diag: null };

  const errs = [...liveErrs, ...staleNotes];
  if ((!apiKey || !apiKey.trim()) && Object.keys(map).length === 0)
    errs.push('(set FRED_API_KEY — the keyless CSV host is sometimes CDN/bot-blocked)');
  return { rates: map, diag: errs.length > 0 ? errs.join('; ') : null };
}
