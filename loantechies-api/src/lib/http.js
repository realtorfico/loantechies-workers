// Small response/parsing helpers shared by every route handler — mirrors the shapes SofticianApi's
// C# handlers return (OkObjectResult / BadRequestObjectResult / UnauthorizedResult / etc.) so ports
// stay a mechanical translation rather than inventing a new response convention.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export const ok = (data) => json(data, 200);
export const badRequest = (error) => json({ error }, 400);
export const notFound = (error) => json({ error }, 404);
export const serviceUnavailable = (error) => json({ error }, 503);
export const unauthorized = () => new Response(null, { status: 401 });

// Mirrors each C# handler's `using var reader = new StreamReader(req.Body); ... JsonConvert.
// DeserializeObject<T>(raw)` try/catch — returns null on empty body or invalid JSON, exactly like
// the C# side's `dto = null` fallback, so callers can respond with the same "Missing or invalid
// JSON." 400.
export async function readJsonBody(request) {
  try {
    const raw = await request.text();
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// D1 stores timestamps as epoch-second INTEGERs, but every `*Utc`-suffixed field the frontend
// consumes (admin's fmtDate()/fmtDateShort() in wwwroot/js/api.js, used across the whole admin
// site) expects `new Date(x)`-parseable input — an ISO 8601 string, matching what ASP.NET's
// default JSON serializer produced for the old C# DateTime responses. `new Date(bareNumber)`
// always means milliseconds, so a raw epoch-seconds integer silently parses as 1970 — every route
// response that includes a `*Utc` field MUST go through this, not just return the D1 column as-is.
export function toIso(epochSeconds) {
  if (epochSeconds == null) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

// Shared admin list-endpoint helpers — mirrors AdminApi.cs's QInt/Page<T>.
export function clampInt(raw, dflt, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

export function paginate(all, page, pageSize) {
  const items = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return { total: all.length, page, pageSize, items };
}
