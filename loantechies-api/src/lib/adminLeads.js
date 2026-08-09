// Port of Admin/AdminApi.cs's console/leads endpoints (GET list+CSV, POST save, POST delete) —
// Access-gated admin lead management. Migrated urgently alongside estimateGate.js: once
// EstimateGate started writing to D1, these routes (still Azure-forwarded) would read a Leads
// table that stopped receiving new rows, making every lead captured after cutover invisible in
// the admin dashboard.
//
// Concurrency note: the C# used the Azure Table ETag for optimistic concurrency on save (a 412 ->
// 409 "changed elsewhere" conflict). D1's `leads` schema has no version column, so this port is
// last-write-wins instead — an accepted simplification for a single-admin-operator site with low
// edit contention, not a faithfulness gap worth a schema change to close.
import { ok, badRequest, notFound, unauthorized, json, readJsonBody, nowSeconds, toIso, clampInt, paginate } from './http.js';
import { requireAccess } from './auth.js';
import { loanTypeOf, purposeOf } from './adminAggregates.js';
import { leadsToCsv } from './adminCsv.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function contains(haystack, needleLower) {
  return (haystack || '').toLowerCase().includes(needleLower);
}

// Admin-safe projection — NEVER include session_token/session_expires_at.
function toLeadDto(row) {
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
    lang: row.lang, loanType: loanTypeOf(row.form_data_json), hasFormData: !!(row.form_data_json && row.form_data_json.trim()),
    createdUtc: toIso(row.created_at), verifiedUtc: toIso(row.verified_at), updatedUtc: toIso(row.updated_at),
    purpose: purposeOf(row.crm_json, row.form_data_json),
    status: row.status, temperature: row.temperature, followUpUtc: toIso(row.follow_up_at),
    notes: row.notes, source: row.source, updatedBy: row.updated_by, deleted: !!row.deleted,
    noEmail: !!row.no_email, lastRateEmailUtc: toIso(row.last_rate_email_at),
    crmJson: row.crm_json, formDataJson: row.form_data_json,
    preApprovalStatus: row.pre_approval_status, preApprovalStatusUpdatedUtc: toIso(row.pre_approval_status_updated_at),
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Sort the full filtered lead set by any column. Default (unknown/empty sort) = newest first.
function sortLeads(rows, sort, desc) {
  const keyFns = {
    name: (r) => `${r.firstName || ''} ${r.lastName || ''}`.trim().toLowerCase(),
    email: (r) => (r.email || '').toLowerCase(),
    phone: (r) => r.phone || '',
    status: (r) => (r.status || '').toLowerCase(),
    temp: (r) => (r.temperature || '').toLowerCase(),
    purpose: (r) => (r.purpose || '').toLowerCase(),
    loantype: (r) => (r.loanType || '').toLowerCase(),
    source: (r) => (r.source || '').toLowerCase(),
    lang: (r) => (r.lang || '').toLowerCase(),
    followup: (r) => r.followUpUtc || '',
    updated: (r) => r.updatedUtc || r.createdUtc,
    created: (r) => r.createdUtc,
  };
  const keyFn = keyFns[sort];
  if (!keyFn) return [...rows].sort((a, b) => cmp(b.createdUtc, a.createdUtc));

  return [...rows].sort((a, b) => {
    const primary = desc ? cmp(keyFn(b), keyFn(a)) : cmp(keyFn(a), keyFn(b));
    return primary !== 0 ? primary : cmp(b.createdUtc, a.createdUtc); // stable secondary: newest first
  });
}

function csvDateStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------- GET console/leads ----------

export async function listLeads(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();
  const sourceFilter = (url.searchParams.get('source') || '').trim().toLowerCase();
  const includeDeleted = (url.searchParams.get('includeDeleted') || '').toLowerCase() === 'true';

  const { results } = await env.DB.prepare('SELECT * FROM leads').all();
  let rows = (results || []).map(toLeadDto);

  if (!includeDeleted) rows = rows.filter((r) => !r.deleted);
  if (statusFilter) rows = rows.filter((r) => (r.status || '').toLowerCase() === statusFilter);
  if (sourceFilter) rows = rows.filter((r) => (r.source || '').toLowerCase() === sourceFilter);
  if (q) rows = rows.filter((r) => contains(r.firstName, q) || contains(r.lastName, q) || contains(r.email, q) || contains(r.phone, q) || contains(r.notes, q));

  rows = sortLeads(rows, (url.searchParams.get('sort') || '').trim().toLowerCase(), (url.searchParams.get('dir') || '').toLowerCase() === 'desc');

  if ((url.searchParams.get('format') || '').toLowerCase() === 'csv') {
    return new Response('﻿' + leadsToCsv(rows), {
      status: 200,
      headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="leads-${csvDateStamp()}.csv"` },
    });
  }

  const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return ok(paginate(rows, page, pageSize));
}

// ---------- POST console/leads/save ----------
// Create (no id) or update (id) a lead. Updates change ONLY the admin-editable fields, so a
// borrower's concurrent autosave (form_data_json/session) is never clobbered.

function parseUtc(s) {
  if (!s || !String(s).trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export async function saveLead(request, env) {
  const adminEmail = await requireAccess(request, env);
  if (!adminEmail) return unauthorized();

  const data = await readJsonBody(request);
  if (!data) return badRequest('Missing or invalid JSON.');

  const hasName = !!(data.firstName && data.firstName.trim()) || !!(data.lastName && data.lastName.trim());
  if (!hasName && !(data.email && data.email.trim())) return badRequest('Enter at least a name or an email.');

  const now = nowSeconds();
  const followUp = parseUtc(data.followUpUtc);
  const crmJson = data.crm != null ? JSON.stringify(data.crm) : null;
  const id = (data.id || '').trim();

  try {
    if (!id) {
      const newId = crypto.randomUUID().replace(/-/g, '');
      await env.DB.prepare(
        `INSERT INTO leads (id, first_name, last_name, email, phone, lang, status, temperature, follow_up_at, notes, no_email, source, created_at, updated_at, updated_by, crm_json, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?, ?, 0)`
      ).bind(
        newId, data.firstName || null, data.lastName || null, data.email || null, data.phone || null,
        data.lang && data.lang.trim() ? data.lang : 'en',
        data.status && data.status.trim() ? data.status : 'New',
        data.temperature || null, followUp, data.notes || null,
        data.noEmail ? 1 : 0, now, now, adminEmail, crmJson
      ).run();
      return ok({ ok: true, id: newId });
    }

    const existing = await env.DB.prepare('SELECT status, lang, no_email FROM leads WHERE id = ?').bind(id).first();
    if (!existing) return notFound('Lead not found.');

    const status = data.status && data.status.trim() ? data.status : (existing.status || 'New');
    const lang = data.lang && data.lang.trim() ? data.lang : existing.lang;
    const noEmail = data.noEmail != null ? (data.noEmail ? 1 : 0) : existing.no_email;

    await env.DB.prepare(
      `UPDATE leads SET first_name=?, last_name=?, email=?, phone=?, lang=?, status=?, temperature=?, follow_up_at=?, notes=?, crm_json=?, no_email=?, updated_at=?, updated_by=? WHERE id=?`
    ).bind(
      data.firstName || null, data.lastName || null, data.email || null, data.phone || null, lang,
      status, data.temperature || null, followUp, data.notes || null, crmJson, noEmail, now, adminEmail, id
    ).run();
    return ok({ ok: true, id });
  } catch (e) {
    console.error(`AdminLeadSave failed — ${e.message}`);
    return json({ error: 'Could not save the lead.' }, 500);
  }
}

// ---------- POST console/leads/delete ----------
// Soft-delete (default) or restore (deleted:false). The row is kept; the list hides deleted leads
// unless ?includeDeleted=true, and stats exclude them.

export async function deleteLead(request, env) {
  const adminEmail = await requireAccess(request, env);
  if (!adminEmail) return unauthorized();

  const data = (await readJsonBody(request)) || {};
  const id = (data.id || '').trim();
  if (!id) return badRequest('Missing lead id.');

  const existing = await env.DB.prepare('SELECT id FROM leads WHERE id = ?').bind(id).first();
  if (!existing) return notFound('Lead not found.');

  const deleted = data.deleted != null ? !!data.deleted : true;
  try {
    await env.DB.prepare('UPDATE leads SET deleted=?, updated_at=?, updated_by=? WHERE id=?').bind(deleted ? 1 : 0, nowSeconds(), adminEmail, id).run();
  } catch (e) {
    console.error(`AdminLeadDelete failed — ${e.message}`);
    return json({ error: 'Could not update the lead.' }, 500);
  }
  return ok({ ok: true, id, deleted });
}
