# loantechies-workers

Cloudflare Workers deployed for LoanTechies / SofticianApi infra. Each subfolder is one Worker,
dashboard-deployed (source pasted into the Worker's Quick Edit, since Wrangler/workerd can't run
locally on this Windows ARM64 machine — see each Worker's README for deploy notes).

This repo exists so the Worker source is version-controlled and available across machines, not as
a build/deploy pipeline. After editing a file here, copy the updated source into the Cloudflare
dashboard editor and deploy from there.

## Workers

- `email-ingest/` — Email Worker on rates@loantechies.com. Content-gates by subject and parses three
  daily rate senders: LoanFactory's rate email, Rocket Pro's correspondent rate sheet (JPG, via
  Workers AI vision), and Provident Funding's WHOLESALE rate grid (base64 HTML — restricted, POSTs to
  its own private backend endpoint). (Repo folder renamed from `loanfactory-email-ingest` 2026-07-13.)
- `loantechies-news/` — Cron Worker (daily). Aggregates curated RSS feeds into KV for the site's
  /news page and homepage widget, with free Workers AI summaries.
- `softician-api-keepalive/` — Cron Worker (every 5 min). Pings the Azure Functions backend's
  /api/health to prevent cold starts.

## Secrets

No secrets are committed here. Each Worker's required secrets/bindings are documented in its own
`wrangler.toml` comments and set via the Cloudflare dashboard (Worker → Settings → Variables &
Secrets / Bindings), not in this repo.
