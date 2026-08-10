#!/usr/bin/env node
// One-off backfill: Azure Blob Storage "document-uploads" container -> R2 "loantechies-documents"
// bucket, preserving blob names verbatim as R2 keys (they already match the
// {submissionId}/{fileIndex}-{sanitizedFileName} scheme documentUpload.js writes/reads — no
// renaming needed). Run AFTER backfill-document-uploads.mjs (the D1 metadata backfill), which
// already wrote files_json.r2Key = the old BlobName for each pre-cutover submission — this script
// is what makes those keys actually resolve against R2.
//
// Copies via R2's S3-compatible API (not the Cloudflare REST API, which doesn't expose per-object
// PUT — only bucket-level management) using @aws-sdk/client-s3. Needs an R2 API token (Access Key
// ID + Secret Access Key), NOT the same as the CF_API_TOKEN used elsewhere in these scripts —
// generate one in the dashboard: R2 > Manage R2 API Tokens > Create API Token, "Object Read &
// Write" permission, scoped to the loantechies-documents bucket if possible.
//
// Required env vars:
//   AZURE_STORAGE_CONNECTION_STRING — the Function App's AzureWebJobsStorage value
//   R2_ACCOUNT_ID                   — Cloudflare account id
//   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY — from the R2 API token above
//   R2_BUCKET_NAME                  — defaults to "loantechies-documents"
// Usage:
//   node backfill-document-blobs.mjs --dry-run          # list what would be copied, touch nothing
//   node backfill-document-blobs.mjs                    # actually copy
//   node backfill-document-blobs.mjs --limit=5           # cap blobs copied (testing)
import { BlobServiceClient } from '@azure/storage-blob';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIMIT = Number([...args].find((a) => a.startsWith('--limit='))?.split('=')[1]) || Infinity;

const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'loantechies-documents';
const CONTAINER_NAME = 'document-uploads';

if (!AZURE_CONN) fail('AZURE_STORAGE_CONNECTION_STRING is not set.');
if (!DRY_RUN && (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY))
  fail('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required unless --dry-run.');

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

const s3 = DRY_RUN ? null : new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

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
        console.error(`item ${idx} failed:`, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return errors;
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (d) => chunks.push(d));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

(async () => {
  const serviceClient = BlobServiceClient.fromConnectionString(AZURE_CONN);
  const container = serviceClient.getContainerClient(CONTAINER_NAME);

  const blobs = [];
  for await (const b of container.listBlobsFlat()) blobs.push(b);
  const slice = blobs.slice(0, LIMIT);
  const totalBytes = slice.reduce((sum, b) => sum + (b.properties.contentLength || 0), 0);
  console.log(`${blobs.length} blob(s) in Azure container "${CONTAINER_NAME}", copying ${slice.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  if (DRY_RUN) {
    console.log('*** DRY RUN — no R2 writes will be made ***');
    for (const b of slice) console.log(`  [dry-run] ${b.name}  (${b.properties.contentLength} bytes, ${b.properties.contentType || 'unknown type'})`);
    console.log('\nDone.');
    return;
  }

  const errors = await pool(slice, async (b) => {
    const blobClient = container.getBlobClient(b.name);

    // Skip if the key already exists in R2 with the same size — makes re-runs cheap/safe.
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: b.name }));
      if (head.ContentLength === b.properties.contentLength) {
        console.log(`  skip (already in R2, same size): ${b.name}`);
        return;
      }
    } catch {
      // 404 (NotFound) is the expected case for a not-yet-copied key — fall through and copy.
    }

    const downloadResp = await blobClient.download();
    const bytes = await streamToBuffer(downloadResp.readableStreamBody);
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: b.name,
      Body: bytes,
      ContentType: b.properties.contentType || 'application/octet-stream',
    }));
    console.log(`  copied: ${b.name} (${bytes.length} bytes)`);
  });

  console.log(`\nDone, ${errors} error(s).`);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
