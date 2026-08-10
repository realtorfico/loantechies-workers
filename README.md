# loantechies-workers

Cloudflare Workers deployed for LoanTechies / SofticianApi infra. Most subfolders are one Worker
each, dashboard-deployed (source pasted into the Worker's Quick Edit, since Wrangler/workerd can't
run locally on this Windows ARM64 machine — see each Worker's README for deploy notes).
`loantechies-api` is the exception — deployed via git-connected Workers Builds instead (see its own
wrangler.jsonc), since Quick Edit's single-file paste doesn't suit its multi-module `src/lib/*`
layout.

This repo exists so the Worker source is version-controlled and available across machines, not as
a build/deploy pipeline. After editing a file here, either copy the updated source into the
Cloudflare dashboard editor (Quick Edit Workers) or push to the connected branch (`loantechies-api`).

## Workers

- `loantechies-api/` — Backend Worker replacing SofticianApi (Azure Functions); every route and
  cron is now ported (see the Azure→Cloudflare migration plan). Reached only via a Service Binding
  from the `loantechies` and `loantechies-admin` Pages/Workers projects. `src/lib/azureForward.js`
  still exists as a fallback for anything not natively implemented, but the Azure Function App
  itself was STOPPED 2026-08-10 (confirmed via `console/azure-fallback` traffic logging showing
  nothing genuinely relied on it) — full resource teardown still pending.
- `email-ingest/` — Email Worker on rates@loantechies.com. Content-gates by subject and parses three
  daily rate senders: LoanFactory's rate email, Rocket Pro's correspondent rate sheet (JPG, via
  Workers AI vision), and Provident Funding's WHOLESALE rate grid (base64 HTML — restricted, POSTs to
  its own private backend endpoint). (Repo folder renamed from `loanfactory-email-ingest` 2026-07-13.)
- `loantechies-news/` — Cron Worker (daily). Aggregates curated RSS feeds into KV for the site's
  /news page and homepage widget, with free Workers AI summaries.

`softician-api-keepalive/` (pinged the Azure host's /api/health every 5 min to prevent cold
starts) was retired and deleted 2026-08-10 once the Azure Function App it existed for was stopped.

## Secrets

No secrets are committed here. Each Worker's required secrets/bindings are documented in its own
`wrangler.toml` comments and set via the Cloudflare dashboard (Worker → Settings → Variables &
Secrets / Bindings), not in this repo.
