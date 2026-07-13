# softician-api-keepalive

A tiny Cloudflare **Worker** with a cron trigger that pings the backend's `/api/health` every
5 minutes, keeping the Azure Functions host warm so the public LoanTechies site doesn't pay a
cold start on the first rate/estimate request.

- `src/index.js` — `scheduled()` does the cron ping; `fetch()` is a manual test hook.
- `wrangler.toml` — `crons = ["*/5 * * * *"]` and the `HEALTH_URL` var.

This is a **standalone Worker**, separate from the `loantechies` / `loantechies-admin` Cloudflare
Pages projects (Pages Functions can't host cron triggers — only real Workers can).

## Deploy

Requires a Cloudflare account (the same one hosting the site). Wrangler runs via `npx`, no global
install needed.

```bash
cd Workers/softician-api-keepalive
npx wrangler login        # one-time, opens a browser to authorize
npx wrangler deploy       # publishes the Worker + registers the cron trigger
```

After deploy:
- **Verify the ping works:** open the Worker's URL (shown by `wrangler deploy`, e.g.
  `https://softician-api-keepalive.<your-subdomain>.workers.dev`) — it returns the backend's
  `{"status":"ok",...}`.
- **Confirm the schedule:** Cloudflare dashboard → Workers & Pages → `softician-api-keepalive`
  → **Triggers** → Cron Triggers shows `*/5 * * * *`. (Or `npx wrangler deployments list`.)
- **Tail live runs:** `npx wrangler tail` — you'll see a scheduled invocation every 5 minutes.

## Change the target or cadence

- Different endpoint: edit `HEALTH_URL` in `wrangler.toml` (or `npx wrangler secret put HEALTH_URL`).
- Different interval: edit the `crons` array (cron is in **UTC**). `*/5 * * * *` = every 5 min, 24/7.
  Business-hours-only is awkward in UTC for a PT business (6am–10pm PT spans midnight UTC), so 24/7
  is simplest and the cost is negligible.
