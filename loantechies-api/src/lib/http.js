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
