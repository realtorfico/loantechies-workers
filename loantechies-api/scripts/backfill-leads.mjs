#!/usr/bin/env node
// One-off backfill: Azure Table Storage "Leads" -> D1 `leads`. Run urgently after the fact — Phase
// 3's EstimateGate/AdminLeads push already went live before this ran, so any lead created ON
// AZURE before cutover needs this to show up in admin; any lead created on the NEW Worker since
// cutover already exists correctly in D1 and is left untouched (upsert is keyed by id, and
// Azure/D1-generated ids never collide).
//
// KNOWN GAP (documented, not fixed by this script): a borrower who had an active Azure session in
// the window between cutover and this backfill running, and who re-verified during that window,
// now has TWO lead rows for the same email — their old pre-cutover Azure row (backfilled here)
// and a fresh D1 row EstimateGate created because it couldn't find them yet. No auto-merge; if it
// happens, dedupe manually in the admin Leads UI (delete the stale duplicate).
//
// Required env vars: AZURE_STORAGE_CONNECTION_STRING, CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN
// Usage:
//   node backfill-leads.mjs --dry-run
//   node backfill-leads.mjs
//   node backfill-leads.mjs --limit=20
import { TableClient } from '@azure/data-tables';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
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

function toEpoch(v) {
  if (v == null) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number') return Math.floor(v > 2e10 ? v / 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

const client = TableClient.fromConnectionString(AZURE_CONN, 'Leads', { allowInsecureConnection: false });

(async () => {
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'lead'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`${items.length} row(s) in Azure, backfilling ${slice.length}`);
  if (DRY_RUN) console.log('*** DRY RUN — no D1 writes will be made ***');

  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO leads (
         id, first_name, last_name, email, phone, lang, created_at, verified_at, updated_at,
         form_data_json, session_token, session_expires_at,
         status, temperature, follow_up_at, notes, source, updated_by, deleted, crm_json,
         no_email, unsubscribe_token, last_rate_email_at,
         pre_approval_status, pre_approval_status_updated_at,
         adverse_action_sent_at, adverse_action_reasons_json,
         incomplete_notice_at, incomplete_deadline_at, incomplete_notice_note, incomplete_reminder_sent_at,
         esign_email_verified_at, esign_consent_at, esign_consent_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         first_name=excluded.first_name, last_name=excluded.last_name, email=excluded.email, phone=excluded.phone,
         lang=excluded.lang, created_at=excluded.created_at, verified_at=excluded.verified_at, updated_at=excluded.updated_at,
         form_data_json=excluded.form_data_json, session_token=excluded.session_token, session_expires_at=excluded.session_expires_at,
         status=excluded.status, temperature=excluded.temperature, follow_up_at=excluded.follow_up_at, notes=excluded.notes,
         source=excluded.source, updated_by=excluded.updated_by, deleted=excluded.deleted, crm_json=excluded.crm_json,
         no_email=excluded.no_email, unsubscribe_token=excluded.unsubscribe_token, last_rate_email_at=excluded.last_rate_email_at,
         pre_approval_status=excluded.pre_approval_status, pre_approval_status_updated_at=excluded.pre_approval_status_updated_at,
         adverse_action_sent_at=excluded.adverse_action_sent_at, adverse_action_reasons_json=excluded.adverse_action_reasons_json,
         incomplete_notice_at=excluded.incomplete_notice_at, incomplete_deadline_at=excluded.incomplete_deadline_at,
         incomplete_notice_note=excluded.incomplete_notice_note, incomplete_reminder_sent_at=excluded.incomplete_reminder_sent_at,
         esign_email_verified_at=excluded.esign_email_verified_at, esign_consent_at=excluded.esign_consent_at,
         esign_consent_version=excluded.esign_consent_version`,
      [
        e.rowKey, e.FirstName ?? null, e.LastName ?? null, e.Email ?? null, e.Phone ?? null, e.Lang || 'en',
        toEpoch(e.CreatedUtc), toEpoch(e.VerifiedUtc), toEpoch(e.UpdatedUtc),
        e.FormDataJson ?? null, e.SessionToken ?? null, toEpoch(e.SessionExpiresUtc),
        e.Status ?? null, e.Temperature ?? null, toEpoch(e.FollowUpUtc), e.Notes ?? null,
        e.Source ?? null, e.UpdatedBy ?? null, e.Deleted ? 1 : 0, e.CrmJson ?? null,
        e.NoEmail ? 1 : 0, e.UnsubscribeToken ?? null, toEpoch(e.LastRateEmailUtc),
        e.PreApprovalStatus ?? null, toEpoch(e.PreApprovalStatusUpdatedUtc),
        toEpoch(e.AdverseActionSentUtc), e.AdverseActionReasonsJson ?? null,
        toEpoch(e.IncompleteNoticeUtc), toEpoch(e.IncompleteDeadlineUtc), e.IncompleteNoticeNote ?? null, toEpoch(e.IncompleteReminderSentUtc),
        toEpoch(e.EsignEmailVerifiedUtc), toEpoch(e.EsignConsentUtc), e.EsignConsentVersion ?? null,
      ]
    );
  });
  console.log(`done, ${errors} error(s)`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
