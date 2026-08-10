// Strangler-fig fallback: forwards any request the router hasn't natively implemented yet to the
// still-live Azure Function App. This is the mechanism that lets the backend migrate one route at
// a time, entirely server-side, with zero further frontend deploys — the frontends were repointed
// to this Worker exactly once (Phase 0). A route "migrates" the moment index.js gets an explicit
// handler for it, checked ahead of this catch-all; reverting a route is deleting that one `if`.
//
// No ExamPrep equivalent — this only exists because loantechies-api is replacing a live monolith
// incrementally, not standing up a greenfield backend.
import { nowSeconds } from './http.js';

// Best-effort, aggregated (not one row per hit) — see schema.sql's azure_fallback_hits comment
// for why this exists (confirming real zero traffic before Phase 6 decommissions Azure) and what
// it deliberately does NOT capture (the keepalive Worker's direct health pings).
async function logFallbackHit(env, method, path) {
  try {
    const now = nowSeconds();
    await env.DB.prepare(
      `INSERT INTO azure_fallback_hits (path, method, count, first_seen_at, last_seen_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(path, method) DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at`
    ).bind(path, method, now, now).run();
  } catch (e) {
    console.warn(`azureForward: fallback-hit logging failed — ${e.message}`);
  }
}

export async function forwardToAzure(request, env, ctx) {
  const origin = env.AZURE_API_ORIGIN || 'https://softician-api.azurewebsites.net';
  const url = new URL(request.url);
  // SofticianApi's Azure Functions routes are conventionally exposed under /api/... — this
  // Worker's own routes are unprefixed (e.g. /loans/estimatedrate), so the frontend's proxy
  // already strips /api before reaching here (see loantechies/worker.js). Re-add it when talking
  // to Azure, whose host.json expects the default routePrefix.
  const target = origin + '/api' + url.pathname + url.search;
  const forwarded = new Request(target, request);

  // Logged via waitUntil so it never adds latency to the actual forwarded response; falls back to
  // a plain fire-and-forget call if somehow invoked without a ctx (defensive, shouldn't happen —
  // index.js's fetch handler always has one).
  const logPromise = logFallbackHit(env, request.method, url.pathname);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(logPromise);

  return fetch(forwarded);
}
