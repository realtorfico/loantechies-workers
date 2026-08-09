#!/usr/bin/env node
// One-off backfill: Azure Table Storage -> D1, for the Phase 3 tables (rate_alerts, savings_alerts,
// inquiries). Run before cutting those routes/cron over, so active Rate Watch / Savings Watch
// subscriptions aren't silently lost. Same shape as backfill-phase1.mjs/backfill-phase2.mjs — see
// that file's header for the shared setup/env-var notes.
//
// Usage:
//   node backfill-phase3.mjs --dry-run
//   node backfill-phase3.mjs
//   node backfill-phase3.mjs --only=rate_alerts       # rate_alerts|savings_alerts|inquiries
//   node backfill-phase3.mjs --limit=20
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

function toEpoch(v, rowLabel) {
  if (v == null) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number') return Math.floor(v > 2e10 ? v / 1000 : v);
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  console.warn(`  ! could not parse timestamp for ${rowLabel}: ${JSON.stringify(v)} — using now`);
  return Math.floor(Date.now() / 1000);
}

function tableClient(tableName) {
  return TableClient.fromConnectionString(AZURE_CONN, tableName, { allowInsecureConnection: false });
}

// --- rate_alerts (RateAlertEntity, table "RateAlerts", PK "alert") --------------------------------
async function backfillRateAlerts() {
  console.log('\n=== rate_alerts ===');
  const client = tableClient('RateAlerts');
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'alert'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`  ${items.length} row(s) in Azure, backfilling ${slice.length}`);
  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO rate_alerts (id, email, term, refinance, target_rate, active, created_at, notified_at, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email=excluded.email, term=excluded.term, refinance=excluded.refinance, target_rate=excluded.target_rate,
         active=excluded.active, created_at=excluded.created_at, notified_at=excluded.notified_at, lang=excluded.lang`,
      [
        e.rowKey, e.Email, Number(e.Term) || 0, e.Refinance ? 1 : 0, Number(e.TargetRate) || 0,
        e.Active === false ? 0 : 1, toEpoch(e.CreatedUtc, `rate_alerts/${e.rowKey}`),
        toEpoch(e.NotifiedUtc, `rate_alerts/${e.rowKey}`), e.Lang || 'en',
      ]
    );
  });
  console.log(`  done, ${errors} error(s)`);
}

// --- savings_alerts (SavingsAlertEntity, table "SavingsAlerts", PK "alert") ------------------------
async function backfillSavingsAlerts() {
  console.log('\n=== savings_alerts ===');
  const client = tableClient('SavingsAlerts');
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'alert'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`  ${items.length} row(s) in Azure, backfilling ${slice.length}`);
  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO savings_alerts (id, email, balance, current_rate, years_left, term, target_savings, active, created_at, notified_at, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email=excluded.email, balance=excluded.balance, current_rate=excluded.current_rate, years_left=excluded.years_left,
         term=excluded.term, target_savings=excluded.target_savings, active=excluded.active,
         created_at=excluded.created_at, notified_at=excluded.notified_at, lang=excluded.lang`,
      [
        e.rowKey, e.Email, Number(e.Balance) || 0, Number(e.CurrentRate) || 0, Number(e.YearsLeft) || 0,
        Number(e.Term) || 0, Number(e.TargetSavings) || 0, e.Active === false ? 0 : 1,
        toEpoch(e.CreatedUtc, `savings_alerts/${e.rowKey}`), toEpoch(e.NotifiedUtc, `savings_alerts/${e.rowKey}`),
        e.Lang || 'en',
      ]
    );
  });
  console.log(`  done, ${errors} error(s)`);
}

// --- inquiries (InquiryEntity, table "Inquiries", PK "inquiry") -------------------------------------
async function backfillInquiries() {
  console.log('\n=== inquiries ===');
  const client = tableClient('Inquiries');
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'inquiry'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`  ${items.length} row(s) in Azure, backfilling ${slice.length}`);
  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO inquiries (id, name, email, phone, zip, source, message, lang, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, email=excluded.email, phone=excluded.phone, zip=excluded.zip,
         source=excluded.source, message=excluded.message, lang=excluded.lang, created_at=excluded.created_at`,
      [
        e.rowKey, e.Name || null, e.Email || null, e.Phone || null, e.Zip || null,
        e.Source || null, e.Message || null, e.Lang || 'en', toEpoch(e.CreatedUtc, `inquiries/${e.rowKey}`),
      ]
    );
  });
  console.log(`  done, ${errors} error(s)`);
}

// --- main --------------------------------------------------------------------------------------
const TABLES = {
  rate_alerts: backfillRateAlerts,
  savings_alerts: backfillSavingsAlerts,
  inquiries: backfillInquiries,
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
