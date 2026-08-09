// Strangler-fig fallback: forwards any request the router hasn't natively implemented yet to the
// still-live Azure Function App. This is the mechanism that lets the backend migrate one route at
// a time, entirely server-side, with zero further frontend deploys — the frontends were repointed
// to this Worker exactly once (Phase 0). A route "migrates" the moment index.js gets an explicit
// handler for it, checked ahead of this catch-all; reverting a route is deleting that one `if`.
//
// No ExamPrep equivalent — this only exists because loantechies-api is replacing a live monolith
// incrementally, not standing up a greenfield backend.

export async function forwardToAzure(request, env) {
  const origin = env.AZURE_API_ORIGIN || 'https://softician-api.azurewebsites.net';
  const url = new URL(request.url);
  // SofticianApi's Azure Functions routes are conventionally exposed under /api/... — this
  // Worker's own routes are unprefixed (e.g. /loans/estimatedrate), so the frontend's proxy
  // already strips /api before reaching here (see loantechies/worker.js). Re-add it when talking
  // to Azure, whose host.json expects the default routePrefix.
  const target = origin + '/api' + url.pathname + url.search;
  const forwarded = new Request(target, request);
  return fetch(forwarded);
}
