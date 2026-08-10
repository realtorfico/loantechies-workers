// Access-gated visibility into azure_fallback_hits (see schema.sql's comment on that table and
// azureForward.js's logging). No Azure/ExamPrep equivalent — purpose-built for confirming real
// zero fallback traffic before Phase 6 decommissions the Azure Function App.
import { ok, unauthorized, toIso } from './http.js';
import { requireAccess } from './auth.js';

export async function listAzureFallbackHits(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const { results } = await env.DB.prepare('SELECT * FROM azure_fallback_hits ORDER BY last_seen_at DESC').all();
  const rows = (results || []).map((r) => ({
    path: r.path, method: r.method, count: r.count,
    firstSeenUtc: toIso(r.first_seen_at), lastSeenUtc: toIso(r.last_seen_at),
  }));
  return ok({ total: rows.length, items: rows });
}
