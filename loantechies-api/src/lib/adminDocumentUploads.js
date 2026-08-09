// Port of Admin/DocumentUploadsApi.cs — Access-gated admin retrieval for the secure document-
// upload portal. No detail endpoint — each submission's file list is small (a handful of files),
// so it's embedded directly in the list response, mirroring how LeadEntity's CRM fields are
// embedded rather than split into a separate endpoint. Files themselves are never proxied through
// this API — file-url mints a short-lived signed URL (documentSign.js) the browser uses to fetch
// the object straight from this Worker's /documents route.
import { ok, unauthorized, notFound, badRequest, toIso, clampInt, paginate } from './http.js';
import { requireAccess } from './auth.js';
import { signDocumentUrl } from './documentSign.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parseFiles(filesJson) {
  if (!filesJson) return [];
  try {
    return JSON.parse(filesJson) || [];
  } catch {
    return [];
  }
}

// BlobName/r2Key deliberately excluded — the admin JS only ever needs a file's array index.
function toUploadDto(row) {
  return {
    id: row.id, borrowerName: row.borrower_name, email: row.email, phone: row.phone,
    purpose: row.purpose, createdUtc: toIso(row.created_at), fileCount: row.file_count,
    totalSizeBytes: row.total_size_bytes, leadId: row.lead_id,
    files: parseFiles(row.files_json).map((f) => ({ fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes })),
  };
}

// ---------- GET console/uploads ----------
// Also used by the admin Lead detail view via ?leadId= to show a specific borrower's linked
// documents inline.
export async function listUploads(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const leadIdFilter = (url.searchParams.get('leadId') || '').trim();

  const { results } = await env.DB.prepare('SELECT * FROM document_uploads').all();
  let rows = (results || []).map(toUploadDto);

  if (leadIdFilter) rows = rows.filter((r) => r.leadId === leadIdFilter);
  else if (q) rows = rows.filter((r) => (r.borrowerName || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q));
  rows.sort((a, b) => (a.createdUtc < b.createdUtc ? 1 : a.createdUtc > b.createdUtc ? -1 : 0));

  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return ok(paginate(rows, page, pageSize));
}

// ---------- GET console/uploads/file-url ----------
export async function getUploadFileUrl(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  const index = parseInt(url.searchParams.get('index'), 10);
  if (!id || !Number.isFinite(index)) return badRequest('id and index are required.');

  const row = await env.DB.prepare('SELECT files_json FROM document_uploads WHERE id = ?').bind(id).first();
  if (!row) return notFound('Submission not found.');

  const files = parseFiles(row.files_json);
  if (index < 0 || index >= files.length) return notFound('File not found.');
  const file = files[index];

  const { url: signedUrl, expiresAt } = await signDocumentUrl(env, file.r2Key, 900);
  return ok({ ok: true, url: signedUrl, expiresUtc: toIso(expiresAt), fileName: file.fileName });
}
