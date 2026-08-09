#!/usr/bin/env node
// One-off backfill: Azure Table Storage -> D1, for the Phase 1 tables (app_config's 5 config keys,
// pmms_cache, external_rates, visits). Run locally (node, not a Worker) — see the migration plan's
// Data migration section. Writes go through the D1 HTTP API (no local wrangler needed on this
// machine, per root CLAUDE.md).
//
// Setup:
//   cd Workers/loantechies-api/scripts && npm install
//
// Required env vars:
//   AZURE_STORAGE_CONNECTION_STRING  — the Function App's AzureWebJobsStorage value
//   CF_ACCOUNT_ID                    — Cloudflare account id (from the dashboard URL)
//   CF_D1_DATABASE_ID                — the loantechies D1 database_id (already in wrangler.jsonc)
//   CF_API_TOKEN                     — a Cloudflare API token with D1 edit permission
//
// Usage:
//   node backfill-phase1.mjs --dry-run          # print what would be written, touch nothing
//   node backfill-phase1.mjs                    # actually write
//   node backfill-phase1.mjs --only=visits       # just one table (app_config|pmms_cache|external_rates|visits)
//   node backfill-phase1.mjs --limit=20          # cap rows per table (testing)
import { TableClient } from '@azure/data-tables';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1];
const LIMIT = Number([...args].find((a) => a.startsWith('--limit='))?.split('=')[1]) || Infinity;

const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!AZURE_CONN) fail('AZURE_STORAGE_CONNECTION_STRING is not set.');
if (!DRY_RUN && (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN))
  fail('CF_ACCOUNT_ID, CF_D1_DATABASE_ID, and CF_API_TOKEN are required unless --dry-run.');

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

// --- D1 HTTP API -------------------------------------------------------------------------------

async function d1Exec(sql, params) {
  if (DRY_RUN) {
    console.log('[dry-run]', sql, JSON.stringify(params));
    return;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`D1 write failed: ${res.status} ${JSON.stringify(data.errors || data)}`);
  }
}

// Small concurrency-limited pool so we don't serialize hundreds of HTTP round-trips one at a time,
// but also don't hammer the API — this is a low-volume site (visits capped at 5000 rows).
async function pool(items, worker, concurrency = 5) {
  let i = 0;
  let errors = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx], idx);
      } catch (e) {
        errors++;
        console.error(`row ${idx} failed:`, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return errors;
}

// --- Timestamp coercion --------------------------------------------------------------------------
// @azure/data-tables returns Edm.DateTime columns as JS Date objects when the entity was written
// with a Date value (the common case here) or ISO strings in some read paths — handle both, and
// fall back to "now" (logged) rather than silently writing garbage.
function toEpoch(v, rowLabel) {
  if (v == null) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number') return Math.floor(v > 2e10 ? v / 1000 : v); // ms vs already-seconds
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  console.warn(`  ! could not parse timestamp for ${rowLabel}: ${JSON.stringify(v)} — using now`);
  return Math.floor(Date.now() / 1000);
}

function tableClient(tableName) {
  return TableClient.fromConnectionString(AZURE_CONN, tableName, { allowInsecureConnection: false });
}

// --- app_config: 5 specific PK="config" rows (skip estimated-rate/history/alert-cooldown — those
// are Phase 2/3 concerns, not Phase 1) ------------------------------------------------------------
// Azure's Json blob is Newtonsoft's default PascalCase serialization of the C# DTO (no camelCase
// naming strategy configured anywhere in SofticianApi — verified). The Worker's read handlers
// expect camelCase (matching what the admin UI/frontend actually consume, same as the C# API
// layer's own explicit re-shaping in each Get handler) — so each blob needs its casing transformed
// on the way into D1, not just copied verbatim.
const CONFIG_TRANSFORMS = {
  'contact': (raw) => ({
    callEnabled: raw.CallEnabled, phone: raw.Phone,
    smsEnabled: raw.SmsEnabled, sms: raw.Sms,
    whatsappEnabled: raw.WhatsappEnabled, whatsapp: raw.Whatsapp,
    calendlyEnabled: raw.CalendlyEnabled, calendlyUrl: raw.CalendlyUrl,
    callbackEnabled: raw.CallbackEnabled, message: raw.Message,
    headline: raw.Headline, subtext: raw.Subtext,
    showEstimateBanner: raw.ShowEstimateBanner,
  }),
  'feature-flags': (raw) => ({ preApprovalEnabled: raw.PreApprovalEnabled }),
  'questionnaire': (raw) => ({ returnEmail: raw.ReturnEmail }),
  'estimate-defaults': (raw) => ({
    fields: Object.fromEntries(
      Object.entries(raw.Fields || {}).map(([k, v]) => [k, { default: v.Default, min: v.Min, max: v.Max }])
    ),
  }),
  'visit-exclusions': (raw) => ({
    ips: raw.Ips || [],
    nameRules: (raw.NameRules || []).map((r) => ({ name: r.Name, location: r.Location })),
  }),
};
const PHASE1_CONFIG_KEYS = Object.keys(CONFIG_TRANSFORMS);

async function backfillAppConfig() {
  console.log('\n=== app_config ===');
  const client = tableClient('AppConfig');
  let n = 0;
  for (const rk of PHASE1_CONFIG_KEYS) {
    if (n >= LIMIT) break;
    let entity;
    try {
      entity = await client.getEntity('config', rk);
    } catch (e) {
      if (e.statusCode === 404) {
        console.log(`  (no row for ${rk} — admin never edited it; D1 will fall back to code defaults)`);
        continue;
      }
      throw e;
    }
    const raw = entity.Json ? JSON.parse(entity.Json) : {};
    const camelCased = JSON.stringify(CONFIG_TRANSFORMS[rk](raw));
    await d1Exec(
      `INSERT INTO app_config (key, json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET json=excluded.json, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [rk, camelCased, entity.Version || 1, toEpoch(entity.UpdatedUtc, `app_config/${rk}`), entity.UpdatedBy || null]
    );
    console.log(`  wrote ${rk}`);
    n++;
  }
}

// --- pmms_cache -----------------------------------------------------------------------------------
async function backfillPmmsCache() {
  console.log('\n=== pmms_cache ===');
  const client = tableClient('PmmsCache');
  let n = 0;
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'pmms'` } })) {
    if (n >= LIMIT) break;
    await d1Exec(
      `INSERT INTO pmms_cache (term, value, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at`,
      [e.rowKey, e.Value, toEpoch(e.FetchedUtc, `pmms_cache/${e.rowKey}`)]
    );
    console.log(`  wrote term=${e.rowKey}`);
    n++;
  }
  console.log(`  ${n} row(s)`);
}

// --- external_rates (all sources: loanfactory, rocketpro, provident) ------------------------------
async function backfillExternalRates() {
  console.log('\n=== external_rates ===');
  const client = tableClient('ExternalRates');
  const items = [];
  for await (const e of client.listEntities()) items.push(e);
  const slice = items.slice(0, LIMIT);
  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO external_rates (source, id, scenario, email_date, posted_date, json, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, id) DO UPDATE SET scenario=excluded.scenario, email_date=excluded.email_date, posted_date=excluded.posted_date, json=excluded.json, saved_at=excluded.saved_at`,
      [
        e.partitionKey, e.rowKey,
        e.Scenario ?? null, e.EmailDate ?? null, e.PostedDate ?? null,
        e.Json || '{}', toEpoch(e.SavedUtc, `external_rates/${e.partitionKey}/${e.rowKey}`),
      ]
    );
  });
  console.log(`  ${slice.length} row(s), ${errors} error(s)`);
}

// --- visits ----------------------------------------------------------------------------------------
async function backfillVisits() {
  console.log('\n=== visits ===');
  const client = tableClient('Visits');
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'visit'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`  ${items.length} row(s) in Azure, backfilling ${slice.length}`);
  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO visits (id, first_seen_at, last_seen_at, duration_ms, page, zip, city, region, lead_id, lang, referrer, ip, user_agent, pages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         first_seen_at=excluded.first_seen_at, last_seen_at=excluded.last_seen_at, duration_ms=excluded.duration_ms,
         page=excluded.page, zip=excluded.zip, city=excluded.city, region=excluded.region, lead_id=excluded.lead_id,
         lang=excluded.lang, referrer=excluded.referrer, ip=excluded.ip, user_agent=excluded.user_agent, pages=excluded.pages`,
      [
        e.rowKey,
        toEpoch(e.FirstSeenUtc, `visits/${e.rowKey}`), toEpoch(e.LastSeenUtc, `visits/${e.rowKey}`),
        Number(e.DurationMs || 0), e.Page || '', e.Zip || '', e.City || '', e.Region || '',
        e.LeadId || '', e.Lang || '', e.Referrer || '', e.Ip || '', e.UserAgent || '', e.Pages || '',
      ]
    );
  });
  console.log(`  done, ${errors} error(s)`);
}

// --- main --------------------------------------------------------------------------------------
const TABLES = {
  app_config: backfillAppConfig,
  pmms_cache: backfillPmmsCache,
  external_rates: backfillExternalRates,
  visits: backfillVisits,
};

if (DRY_RUN) console.log('*** DRY RUN — no D1 writes will be made ***');

(async () => {
  const toRun = ONLY ? [ONLY] : Object.keys(TABLES);
  for (const name of toRun) {
    if (!TABLES[name]) fail(`Unknown --only value '${name}'. Valid: ${Object.keys(TABLES).join(', ')}`);
    await TABLES[name]();
  }
  console.log('\nDone.');
})().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
