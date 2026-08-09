// Port of Loans/PmmsProvider.cs's PmmsCacheStore — storage-only, no direct HTTP route in the C#
// either. Only consumer is Loans/RatesCurrentFunction.cs (GET loans/rates/current), which migrates
// in Phase 2 along with the FRED-fetch logic that populates this cache. Ported now so the table
// exists and is usable the moment that route lands, without a separate storage-layer PR later.
import { nowSeconds } from './http.js';

export async function loadPmms(env, term) {
  const row = await env.DB.prepare('SELECT value, fetched_at FROM pmms_cache WHERE term = ?').bind(String(term)).first();
  if (!row) return null;
  return { value: row.value, fetchedUtc: row.fetched_at };
}

export async function savePmms(env, term, value, fetchedUtc) {
  await env.DB.prepare(
    `INSERT INTO pmms_cache (term, value, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`
  ).bind(String(term), value, fetchedUtc ?? nowSeconds()).run();
}
