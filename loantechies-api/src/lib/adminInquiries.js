// Port of Admin/AdminApi.cs's console/inquiries endpoint (Access-gated list). Migrated urgently
// alongside adminLeads.js/adminAlerts.js — same stale-read gap.
import { ok, unauthorized, toIso, clampInt, paginate } from './http.js';
import { requireAccess } from './auth.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function toInquiryDto(row) {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone, zip: row.zip,
    source: row.source, message: row.message, lang: row.lang, createdUtc: toIso(row.created_at),
  };
}

export async function listInquiries(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  const { results } = await env.DB.prepare('SELECT * FROM inquiries').all();
  let rows = (results || []).map(toInquiryDto);
  if (q) {
    rows = rows.filter((r) =>
      (r.name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q) ||
      (r.phone || '').toLowerCase().includes(q) || (r.source || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => (a.createdUtc < b.createdUtc ? 1 : a.createdUtc > b.createdUtc ? -1 : 0));

  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return ok(paginate(rows, page, pageSize));
}
