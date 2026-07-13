/**
 * Keep-alive Worker for softician-api (Azure Functions).
 *
 * The cron trigger (see wrangler.toml — every 5 min) calls scheduled(), which pings the backend's
 * /api/health endpoint. Each ping executes inside the Functions host, keeping the .NET process
 * loaded so the public site's first real rate/estimate request doesn't pay a cold start.
 *
 * The fetch() handler is just a manual test hook: open the Worker's URL in a browser to trigger a
 * ping on demand and see the backend's response (handy for verifying after deploy).
 */

async function pingHealth(env) {
  const base = (env && env.HEALTH_URL) || "https://softician-api.azurewebsites.net/api/health";
  // Cache-bust + no-store so neither Cloudflare nor any intermediary serves a cached 200 (which
  // would defeat the warm-up — the request must actually reach Azure).
  const url = base + (base.includes("?") ? "&" : "?") + "src=cf-cron&t=" + Date.now();
  const res = await fetch(url, { cf: { cacheTtl: 0 }, headers: { "cache-control": "no-cache" } });
  return res;
}

export default {
  async scheduled(event, env, ctx) {
    // waitUntil keeps the Worker alive until the ping resolves; swallow errors so one failed ping
    // never throws (the next tick in 5 min retries anyway).
    ctx.waitUntil(pingHealth(env).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    try {
      const res = await pingHealth(env);
      const body = await res.text();
      return new Response(body || `pinged: ${res.status}`, {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};
