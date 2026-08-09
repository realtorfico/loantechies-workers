// loantechies-api — Cloudflare Worker backend for loantechies.com / admin.loantechies.com,
// migrating off SofticianApi (Azure Functions) one route at a time. See wrangler.jsonc for
// bindings/deploy notes and the migration plan for phasing.
//
// Router shape mirrors examprep-api/src/index.js: a flat if(pathname && method) chain. Every
// migrated route gets an explicit branch ABOVE the forwardToAzure() fallback at the bottom —
// anything without a branch here transparently rides on Azure until it's ported.
import { forwardToAzure } from './lib/azureForward.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Native health check — proves the Worker itself deployed and is reachable, independent of
    // whatever fraction of routes still forward to Azure. Not the same thing as SofticianApi's
    // /api/health (which only proves the Azure host is alive); see the Phase 0+ daily
    // secret-presence health check (still to be added) for that concern's Cloudflare-side
    // equivalent.
    if (pathname === '/health' && method === 'GET') {
      return new Response(JSON.stringify({ ok: true, service: 'loantechies-api' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // ---- Migrated routes go here, one `if` per route, as each phase lands. ----
    // (Phase 0: none yet — everything below falls through to Azure.)

    return forwardToAzure(request, env);
  },

  // Cron dispatch is added once the first timer-triggered route migrates (Phase 3+) — see
  // wrangler.jsonc's commented-out "triggers" block and the migration plan's cron mapping table.
};
