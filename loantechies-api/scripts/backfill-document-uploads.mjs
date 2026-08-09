#!/usr/bin/env node
// One-off backfill: Azure Table Storage "DocumentUploads" -> D1 `document_uploads`. Same shape as
// backfill-leads.mjs — see that file's header for the shared setup/env-var notes.
//
// METADATA ONLY. The actual file bytes are NOT copied by this script — they still live in Azure's
// "document-uploads" Blob container. Per the migration plan, moving them to R2 is its own step
// (try Cloudflare's Super Slurper first — dashboard, bucket-to-bucket, supports Azure Blob
// sources; fall back to a script/rclone copy if that doesn't fit). This script is safe to run
// before that copy happens: it writes files_json.r2Key using the SAME path scheme the old blob
// names used ({submissionId}/{fileIndex}-{sanitizedFileName}), so once the blob copy preserves
// that key structure, the metadata already backfilled here resolves correctly with no second
// pass needed. Until the blob copy runs, signed download links for these backfilled (pre-cutover)
// rows will 404 against R2 — new (post-cutover) uploads work immediately since they write straight
// to R2 already.
//
// Field rename during backfill: Azure's FilesJson is Newtonsoft PascalCase (FileName, BlobName,
// ContentType, SizeBytes) — the new D1/JS side is camelCase AND renames BlobName -> r2Key (see
// documentUpload.js). Transformed here, not copied verbatim — same PascalCase-vs-camelCase
// caveat as every other JSON-blob backfill in this migration (see backfill-phase1.mjs's
// CONFIG_TRANSFORMS comment).
//
// Required env vars: AZURE_STORAGE_CONNECTION_STRING, CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN
// Usage:
//   node backfill-document-uploads.mjs --dry-run
//   node backfill-document-uploads.mjs
//   node backfill-document-uploads.mjs --limit=20
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

// PascalCase Azure FilesJson -> camelCase D1 shape, BlobName -> r2Key.
function transformFiles(filesJsonRaw) {
  if (!filesJsonRaw) return '[]';
  let parsed;
  try {
    parsed = JSON.parse(filesJsonRaw);
  } catch {
    return '[]';
  }
  const files = (parsed || []).map((f) => ({
    fileName: f.FileName ?? null,
    r2Key: f.BlobName ?? null,
    contentType: f.ContentType ?? null,
    sizeBytes: Number(f.SizeBytes || 0),
  }));
  return JSON.stringify(files);
}

const client = TableClient.fromConnectionString(AZURE_CONN, 'DocumentUploads', { allowInsecureConnection: false });

(async () => {
  const items = [];
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'submission'` } })) items.push(e);
  const slice = items.slice(0, LIMIT);
  console.log(`${items.length} row(s) in Azure, backfilling ${slice.length}`);
  if (DRY_RUN) console.log('*** DRY RUN — no D1 writes will be made ***');

  const errors = await pool(slice, async (e) => {
    await d1Exec(
      `INSERT INTO document_uploads (id, borrower_name, email, phone, purpose, created_at, files_json, file_count, total_size_bytes, lead_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         borrower_name=excluded.borrower_name, email=excluded.email, phone=excluded.phone, purpose=excluded.purpose,
         created_at=excluded.created_at, files_json=excluded.files_json, file_count=excluded.file_count,
         total_size_bytes=excluded.total_size_bytes, lead_id=excluded.lead_id`,
      [
        e.rowKey, e.BorrowerName ?? null, e.Email ?? null, e.Phone ?? null, e.Purpose ?? null,
        toEpoch(e.CreatedUtc), transformFiles(e.FilesJson), Number(e.FileCount || 0), Number(e.TotalSizeBytes || 0),
        e.LeadId ?? null,
      ]
    );
  });
  console.log(`done, ${errors} error(s)`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
