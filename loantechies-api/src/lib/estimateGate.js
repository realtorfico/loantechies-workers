// Port of Leads/EstimateGate.cs — email-based 2FA gate in front of the What's My Rate tool, plus
// the E-SIGN consent round-trip that unlocks Reg B compliance notices for pre-approval. Highest-
// stakes table in the migration (OTP session, admin CRM fields, Reg B §1002.9 adverse-
// action/incomplete-notice fields, E-SIGN consent) — see schema.sql's header comment on `leads`.
//
// Eight endpoints:
//   POST leads/estimate/request-otp             — capture name/email(/phone), email a 6-digit code
//   POST leads/estimate/verify                   — check the code, store the lead, return a 7-day token
//   POST leads/estimate/save                     — token-gated; persist form data (+ pre-approval submit)
//   POST leads/estimate/esign/request-code       — session-gated; emails a code to a just-entered address
//   POST leads/estimate/esign/confirm-code       — session-gated; on match, stamps EsignEmailVerifiedUtc
//   POST leads/estimate/verify-employer-address  — session-gated; Google Address Validation, advisory only
//   POST leads/estimate/status                   — session-gated; borrower-facing status + document list
//   POST leads/estimate/quick-start               — phone-only, no OTP, Turnstile-gated
import { ok, badRequest, unauthorized, json, readJsonBody, nowSeconds, toIso } from './http.js';
import { verifyTurnstile } from './auth.js';
import { sendViaResend, langCode } from './emailer.js';
import { verify as verifyAddress } from './googleAddress.js';
import { SUBMITTED } from './preApprovalStatus.js';

export const OTP_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECS = 60;
export const MAX_ATTEMPTS = 5;
export const SESSION_DAYS = 7;

// Which version of the E-SIGN disclosure text a borrower agreed to — bump if the wording
// materially changes, so existing consents remain interpretable against the text they saw.
export const ESIGN_CONSENT_VERSION_CURRENT = 'v1';

// ---------- pure helpers (unit-tested) ----------

export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// Requires the dot specifically in the DOMAIN part (after @), matching the frontend's
// isValidEmail (core.js: /^[^\s@]+@[^\s@]+\.[^\s@]+$/).
export function isValidEmail(email) {
  email = (email || '').trim();
  if (email.length < 3 || email.length > 254) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at >= email.length - 1) return false;
  if (email.indexOf('@', at + 1) >= 0) return false;
  return email.indexOf('.', at + 1) > at;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Stable, key-safe D1 primary key derived from the email (avoids PII / illegal chars in keys).
export async function emailKey(email) {
  return sha256Hex(normalizeEmail(email));
}

// Cryptographically-random 6-digit code, zero-padded. Rejection-sampled to avoid modulo bias.
export function generateCode() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

// Salted SHA-256 of the code. Salting with the email binds a code to one address.
export async function hashCode(code, emailSalt) {
  return sha256Hex(`${normalizeEmail(emailSalt)}:${code ?? ''}`);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Constant-time-ish compare of a submitted code against the stored hash.
export async function codeMatches(code, emailSalt, expectedHash) {
  if (!expectedHash || !code || !code.trim()) return false;
  return timingSafeEqual(await hashCode(code, emailSalt), expectedHash);
}

export function isExpired(expiresAt, now) {
  return now >= expiresAt;
}

// True once enough time has passed since the last send to allow a resend.
export function canResend(sentAt, now) {
  return now - sentAt >= RESEND_COOLDOWN_SECS;
}

export function countDigits(s) {
  return ((s || '').match(/\d/g) || []).length;
}

export function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

// Split a full name into (first, rest) on the first space; last may be empty.
export function splitName(full) {
  full = (full || '').trim();
  const sp = full.indexOf(' ');
  return sp < 0 ? { first: full, last: '' } : { first: full.slice(0, sp).trim(), last: full.slice(sp + 1).trim() };
}

// Pure and exported for testing. Gates SaveLead's first pre-approval submission on E-SIGN consent
// (15 U.S.C. §7001(c)): the borrower must have checked the consent box AND already verified (via
// esignRequestCode/esignConfirmCode) the SAME address they're submitting now — comparing against
// the pre-overwrite lead email catches a borrower who verified one address and edited the field
// afterward without re-verifying.
export function canAcceptEsignConsent(esignConsent, emailVerifiedAt, verifiedEmail, submittingEmail) {
  if (!esignConsent) return { ok: false, error: 'Please confirm you agree to receive notices about your application by email.' };
  if (emailVerifiedAt == null || normalizeEmail(verifiedEmail) !== normalizeEmail(submittingEmail))
    return { ok: false, error: 'Please verify your email before submitting.' };
  return { ok: true, error: null };
}

// OTP email copy, per borrower language (en/es/hi/te).
export function buildOtpEmail(langRaw, firstName, code) {
  const c = langCode(langRaw);
  const name = firstName ? ' ' + firstName : '';
  if (c === 'es')
    return {
      subject: 'Tu codigo de Loan Techies: ' + code,
      body: `Hola${name},\n\nTu codigo de verificacion es: ${code}\n\n` +
        `Vence en ${OTP_TTL_MINUTES} minutos. Si no lo solicitaste, ignora este correo.\n\n` +
        signatureFor(c),
    };
  if (c === 'hi')
    return {
      subject: 'Aapka Loan Techies code: ' + code,
      body: `Namaste${name},\n\nAapka verification code hai: ${code}\n\n` +
        `Yeh ${OTP_TTL_MINUTES} minute mein expire ho jaayega. Agar aapne request nahi kiya, is email ko ignore karein.\n\n` +
        signatureFor(c),
    };
  if (c === 'te')
    return {
      subject: 'Mee Loan Techies code: ' + code,
      body: `Namaskaram${name},\n\nMee verification code: ${code}\n\n` +
        `Idi ${OTP_TTL_MINUTES} nimishaalalo expire avtundi. Meeru request cheyakapote, ee email ni ignore cheyandi.\n\n` +
        signatureFor(c),
    };
  return {
    subject: 'Your Loan Techies code: ' + code,
    body: `Hi${name},\n\nYour verification code is: ${code}\n\n` +
      `It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.\n\n` +
      signatureFor(c),
  };
}

function signatureFor(code) {
  const role = code === 'es' ? 'Originador de Préstamos Hipotecarios' : 'Mortgage Loan Originator';
  return `Anand V.\n${role}\nNMLS #2471270 | CA-DRE #02208256\nLoan Factory - Tracy, CA\nhttps://www.loantechies.com`;
}

// ---------- storage helpers ----------

async function findLeadByEmail(env, email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  return (await env.DB.prepare('SELECT * FROM leads WHERE LOWER(TRIM(email)) = ? ORDER BY created_at DESC LIMIT 1').bind(norm).first()) || null;
}

// Best-effort dedupe by phone (phone isn't a key, so scan the whole — small — table).
async function findLeadByPhone(env, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const { results } = await env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  for (const row of results || []) {
    if (normalizePhone(row.phone) === norm) return row;
  }
  return null;
}

function sessionValid(lead, token, now) {
  return !!lead && lead.session_token === token && !isExpired(lead.session_expires_at ?? -Infinity, now);
}

// Emails the MLO a pre-approval request summary. Awaited by the caller — an un-awaited Task here
// would race the Worker's own response teardown, same reasoning as SendInquiry/RateAlert/
// SavingsAlert: every critical-path notification in this codebase awaits for exactly this reason.
async function sendPreApprovalEmail(env, lead, summary) {
  try {
    const to = env.INQUIRY_TO_EMAIL || env.GMAIL_USER;
    if (!to) {
      console.warn('pre-approval notify: no recipient configured.');
      return;
    }
    const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    let body = "New pre-approval request from the What's My Rate funnel.\n\n" +
      `Name:  ${name}\nPhone: ${lead.phone || ''}\nEmail: ${lead.email || ''}\nLang:  ${lead.lang || 'en'}\n`;
    if (summary) body += `\nScenario:\n${summary}\n`;
    body += `\nView in admin → Leads · lead id ${lead.id}`;
    await sendViaResend(env, to, '[LoanTechies] Pre-approval request — ' + (name.length > 0 ? name : lead.phone || ''), body);
  } catch (e) {
    console.warn(`pre-approval notify email failed — ${e.message}`);
  }
}

// ---------- POST leads/estimate/request-otp ----------

export async function requestOtp(request, env) {
  const data = (await readJsonBody(request)) || {};

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!(await verifyTurnstile(data.turnstileToken, env.TURNSTILE_SECRET, clientIp))) return new Response(null, { status: 403 });

  const firstName = (data.firstName || '').trim();
  const lastName = (data.lastName || '').trim();
  const email = (data.email || '').trim();
  const phone = (data.phone || '').trim();
  const lang = langCode(data.lang);

  if (!firstName || !lastName) return badRequest('First and last name are required.');
  if (!isValidEmail(email)) return badRequest('A valid email is required.');
  if (firstName.length > 80 || lastName.length > 80 || phone.length > 40) return badRequest('One of the fields is too long.');

  const rowKey = await emailKey(email);
  const now = nowSeconds();

  const existing = await env.DB.prepare('SELECT sent_at FROM estimate_otps WHERE id = ?').bind(rowKey).first();
  if (existing && !canResend(existing.sent_at, now)) return json({ error: 'Please wait a moment before requesting another code.' }, 429);

  const code = generateCode();
  try {
    await env.DB.prepare(
      `INSERT INTO estimate_otps (id, code_hash, first_name, last_name, email, phone, lang, expires_at, sent_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash, first_name=excluded.first_name, last_name=excluded.last_name,
         email=excluded.email, phone=excluded.phone, lang=excluded.lang, expires_at=excluded.expires_at, sent_at=excluded.sent_at, attempts=0`
    ).bind(rowKey, await hashCode(code, email), firstName, lastName, email, phone, lang, now + OTP_TTL_MINUTES * 60, now).run();
  } catch (e) {
    console.error(`EstimateGate: OTP store failed — ${e.message}`);
    return json({ error: 'Could not start verification.' }, 500);
  }

  const { subject, body } = buildOtpEmail(lang, firstName, code);
  if (!(await sendViaResend(env, email, subject, body))) return json({ error: "We couldn't send the code. Please try again." }, 502);

  return ok({ ok: true });
}

// ---------- POST leads/estimate/verify ----------

export async function verifyOtp(request, env) {
  const data = (await readJsonBody(request)) || {};
  const email = (data.email || '').trim();
  const code = (data.code || '').trim();
  if (!isValidEmail(email) || !code) return badRequest('Email and code are required.');

  const rowKey = await emailKey(email);
  const otp = await env.DB.prepare('SELECT * FROM estimate_otps WHERE id = ?').bind(rowKey).first();
  if (!otp) return ok({ ok: false, error: 'No code found — please request a new one.' });

  const now = nowSeconds();

  if (isExpired(otp.expires_at, now)) {
    await env.DB.prepare('DELETE FROM estimate_otps WHERE id = ?').bind(rowKey).run().catch(() => {});
    return ok({ ok: false, error: 'That code has expired — please request a new one.' });
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM estimate_otps WHERE id = ?').bind(rowKey).run().catch(() => {});
    return ok({ ok: false, error: 'Too many attempts — please request a new code.' });
  }
  if (!(await codeMatches(code, email, otp.code_hash))) {
    await env.DB.prepare('UPDATE estimate_otps SET attempts = attempts + 1 WHERE id = ?').bind(rowKey).run().catch(() => {});
    return ok({ ok: false, error: "That code didn't match. Please try again." });
  }

  // Verified — burn the OTP, store/refresh the lead, and mint a 7-day session token.
  await env.DB.prepare('DELETE FROM estimate_otps WHERE id = ?').bind(rowKey).run().catch(() => {});

  const sessionToken = crypto.randomUUID().replace(/-/g, '');
  const sessionExpiresAt = now + SESSION_DAYS * 86400;
  const existingLead = await findLeadByEmail(env, otp.email);
  const leadId = existingLead ? existingLead.id : crypto.randomUUID().replace(/-/g, '');

  try {
    if (!existingLead) {
      await env.DB.prepare(
        `INSERT INTO leads (id, first_name, last_name, email, phone, lang, created_at, verified_at, session_token, session_expires_at, status, source, updated_by, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', 'estimate', 'system (verify)', 0)`
      ).bind(leadId, otp.first_name, otp.last_name, otp.email, otp.phone, otp.lang, now, now, sessionToken, sessionExpiresAt).run();
    } else {
      await env.DB.prepare(
        `UPDATE leads SET first_name=?, last_name=?, email=?, phone=?, lang=?, verified_at=?, session_token=?, session_expires_at=?, updated_by='system (verify)' WHERE id=?`
      ).bind(otp.first_name, otp.last_name, otp.email, otp.phone, otp.lang, now, sessionToken, sessionExpiresAt, leadId).run();
    }
  } catch (e) {
    console.error(`EstimateGate: lead store failed — ${e.message}`);
    return json({ error: 'Could not complete verification.' }, 500);
  }

  return ok({ ok: true, leadId, token: sessionToken, expiresMs: sessionExpiresAt * 1000 });
}

// ---------- POST leads/estimate/save ----------

export async function saveLead(request, env) {
  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const token = (data.token || '').trim();
  if (!leadId || !token) return badRequest('Missing session.');

  // Pre-approval "submit" sets notify=true (+ email/summary): stamp the lead and email the MLO.
  // Token-gated like the rest of this endpoint, so no Turnstile is needed on the form page.
  let notify = false;
  try { if (data.notify != null) notify = Boolean(data.notify); } catch { notify = false; }
  const email = (data.email || '').trim();
  let summary = (data.summary || '').trim();
  if (summary.length > 4000) summary = summary.slice(0, 4000);

  // formData is an arbitrary JSON object — re-serialize it for storage.
  let formJson = null;
  try { if (data.formData != null) formJson = JSON.stringify(data.formData); } catch {}
  if (formJson != null && formJson.length > 32000) formJson = formJson.slice(0, 32000);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  const now = nowSeconds();
  if (!sessionValid(lead, token, now)) return unauthorized();

  let newEmail = null;
  let newStatus = null;
  let preApprovalStatus = null;
  let preApprovalStatusUpdatedAt = null;
  let esignConsentAt = null;
  let esignConsentVersion = null;

  if (notify) {
    // Only set on the FIRST submission — a later autosave (or a second notify=true call,
    // shouldn't happen but be defensive) must never downgrade a status Anand has already moved
    // forward (e.g. back from "Under Review" to "Submitted").
    const firstSubmission = !lead.pre_approval_status;

    if (firstSubmission) {
      // E-SIGN Act consent gate (15 U.S.C. §7001(c)) — checked against lead.email BEFORE it's
      // overwritten by the incoming value below, so a borrower who verified one address and then
      // edited the field before hitting submit is caught, not silently accepted.
      let esignConsent = false;
      try { if (data.esignConsent != null) esignConsent = Boolean(data.esignConsent); } catch { esignConsent = false; }
      const { ok: esignOk, error: esignError } = canAcceptEsignConsent(esignConsent, lead.esign_email_verified_at, lead.email, email);
      if (!esignOk) return badRequest(esignError);
    } else {
      // A LATER submission can still change the email — consent itself is already on file, so
      // this only re-proves the NEW address is reachable via the same code round-trip, rather
      // than silently overwriting lead.email with an unverified value.
      const emailAlreadyVerified = lead.esign_email_verified_at != null && normalizeEmail(lead.email) === normalizeEmail(email);
      if (!emailAlreadyVerified) return json({ error: 'Please verify your new email before saving.', emailChanged: true }, 400);
    }

    if (email) newEmail = email.length > 200 ? email.slice(0, 200) : email;
    newStatus = 'App Started'; // pre-approval request submitted
    if (firstSubmission) {
      preApprovalStatus = SUBMITTED;
      preApprovalStatusUpdatedAt = now;
      esignConsentAt = now;
      esignConsentVersion = ESIGN_CONSENT_VERSION_CURRENT;
    }
  }

  try {
    await env.DB.prepare(
      `UPDATE leads SET
         form_data_json = COALESCE(?, form_data_json), updated_at = ?, updated_by = ?,
         email = COALESCE(?, email), status = COALESCE(?, status),
         pre_approval_status = COALESCE(?, pre_approval_status),
         pre_approval_status_updated_at = COALESCE(?, pre_approval_status_updated_at),
         esign_consent_at = COALESCE(?, esign_consent_at),
         esign_consent_version = COALESCE(?, esign_consent_version)
       WHERE id = ?`
    ).bind(
      formJson, now, notify ? 'system (pre-approval)' : 'system (autosave)',
      newEmail, newStatus, preApprovalStatus, preApprovalStatusUpdatedAt, esignConsentAt, esignConsentVersion,
      leadId
    ).run();
  } catch (e) {
    console.warn(`EstimateGate: lead save failed — ${e.message}`);
    return json({ error: 'Could not save.' }, 500);
  }

  // Awaited, not fire-and-forget — see sendPreApprovalEmail's own comment.
  if (notify) await sendPreApprovalEmail(env, { ...lead, id: leadId, email: newEmail || lead.email }, summary);

  return ok({ ok: true });
}

// ---------- POST leads/estimate/esign/request-code ----------
// Session-gated (leadId+token) — emails a short code to the address the borrower just typed into
// the pre-approval form, so saveLead's E-SIGN consent gate can later confirm it's reachable.
// Stored in esign_otps keyed by leadId — this round-trip belongs to one specific,
// already-authenticated lead, not a fresh identity lookup like request-otp/verify above.

export async function esignRequestCode(request, env) {
  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const token = (data.token || '').trim();
  const email = (data.email || '').trim();
  if (!leadId || !token) return badRequest('Missing session.');
  if (!isValidEmail(email)) return badRequest('A valid email is required.');

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  const now = nowSeconds();
  if (!sessionValid(lead, token, now)) return unauthorized();

  const existing = await env.DB.prepare('SELECT sent_at FROM esign_otps WHERE id = ?').bind(leadId).first();
  if (existing && !canResend(existing.sent_at, now)) return json({ error: 'Please wait a moment before requesting another code.' }, 429);

  const code = generateCode();
  try {
    await env.DB.prepare(
      `INSERT INTO esign_otps (id, code_hash, email, lang, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash, email=excluded.email, lang=excluded.lang, expires_at=excluded.expires_at, sent_at=excluded.sent_at, attempts=0`
    ).bind(leadId, await hashCode(code, email), email, lead.lang || 'en', now + OTP_TTL_MINUTES * 60, now).run();
  } catch (e) {
    console.error(`EstimateGate (esign): OTP store failed — ${e.message}`);
    return json({ error: 'Could not send a code.' }, 500);
  }

  const { subject, body } = buildOtpEmail(lead.lang, lead.first_name, code);
  if (!(await sendViaResend(env, email, subject, body))) return json({ error: "We couldn't send the code. Please try again." }, 502);

  return ok({ ok: true });
}

// ---------- POST leads/estimate/esign/confirm-code ----------
// Session-gated. On a correct code, stamps esign_email_verified_at on the SAME lead record — no
// new lead, no new session token (contrast verifyOtp above).

export async function esignConfirmCode(request, env) {
  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const token = (data.token || '').trim();
  const code = (data.code || '').trim();
  if (!leadId || !token || !code) return badRequest('Missing session or code.');

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  const now = nowSeconds();
  if (!sessionValid(lead, token, now)) return unauthorized();

  // needsNewCode:true on the three dead-end cases (row gone/expired/too-many-attempts) tells the
  // frontend to reset its "a code is pending" state and prompt a fresh request-code round-trip,
  // instead of retrying against a row that can never succeed again. Omitted on a plain wrong-code
  // miss, where retyping against the SAME still-live code is the correct next action.
  const otp = await env.DB.prepare('SELECT * FROM esign_otps WHERE id = ?').bind(leadId).first();
  if (!otp) return ok({ ok: false, error: 'No code found — please request a new one.', needsNewCode: true });

  if (isExpired(otp.expires_at, now)) {
    await env.DB.prepare('DELETE FROM esign_otps WHERE id = ?').bind(leadId).run().catch(() => {});
    return ok({ ok: false, error: 'That code has expired — please request a new one.', needsNewCode: true });
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM esign_otps WHERE id = ?').bind(leadId).run().catch(() => {});
    return ok({ ok: false, error: 'Too many attempts — please request a new code.', needsNewCode: true });
  }
  if (!(await codeMatches(code, otp.email, otp.code_hash))) {
    await env.DB.prepare('UPDATE esign_otps SET attempts = attempts + 1 WHERE id = ?').bind(leadId).run().catch(() => {});
    return ok({ ok: false, error: "That code didn't match. Please try again." });
  }

  await env.DB.prepare('DELETE FROM esign_otps WHERE id = ?').bind(leadId).run().catch(() => {});

  try {
    await env.DB.prepare('UPDATE leads SET email = ?, esign_email_verified_at = ? WHERE id = ?').bind(otp.email, now, leadId).run();
  } catch (e) {
    console.warn(`EstimateGate (esign): lead save failed — ${e.message}`);
    return json({ error: 'Could not confirm.' }, 500);
  }

  return ok({ ok: true });
}

// ---------- POST leads/estimate/verify-employer-address ----------
// Session-gated, same shape as the esign endpoints above. Real US address verification on top of
// the frontend's basic format check; advisory only — a false "undeliverable" from a third-party
// service shouldn't be able to stop a legitimate submission outright.

export async function verifyEmployerAddress(request, env) {
  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const token = (data.token || '').trim();
  if (!leadId || !token) return badRequest('Missing session.');

  const lead = await env.DB.prepare('SELECT session_token, session_expires_at FROM leads WHERE id = ?').bind(leadId).first();
  const now = nowSeconds();
  if (!sessionValid(lead, token, now)) return unauthorized();

  const street = (data.street || '').trim();
  const city = (data.city || '').trim();
  const state = (data.state || '').trim();
  const zip = (data.zip || '').trim();

  const result = await verifyAddress(street, city, state, zip, env);
  if (!result.configured) return ok({ ok: true, configured: false });

  return ok({
    ok: true,
    configured: true,
    deliverable: result.deliverable,
    suggested: result.suggestedStreet != null
      ? { street: result.suggestedStreet, city: result.suggestedCity, state: result.suggestedState, zip: result.suggestedZip }
      : null,
  });
}

// ---------- POST leads/estimate/status ----------
// Borrower-facing "check my status" — same session contract as leads/estimate/save. Returns the
// lead's own status plus every document they've uploaded, flattened and sorted newest-first.
// POST (not GET) so the session token never lands in a URL/query string/access log.

export async function status(request, env) {
  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const token = (data.token || '').trim();
  if (!leadId || !token) return badRequest('Missing session.');

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  const now = nowSeconds();
  if (!sessionValid(lead, token, now)) return unauthorized();

  // Document listing depends on document_uploads, which migrates in Phase 4 — until that ships
  // and backfills, this returns no documents for uploads still living only in Azure. Self-
  // resolves once Phase 4 lands (the very next phase). Field names checked both camelCase (fresh
  // JS-written rows) and PascalCase (a Phase 4 backfill of Newtonsoft-serialized FilesJson) so
  // neither shape silently drops data.
  const documents = [];
  try {
    const { results } = await env.DB.prepare('SELECT files_json, created_at FROM document_uploads WHERE lead_id = ?').bind(leadId).all();
    for (const u of results || []) {
      let files = [];
      try { files = u.files_json ? JSON.parse(u.files_json) : []; } catch {}
      for (const f of files) documents.push({ fileName: f.fileName ?? f.FileName, sizeBytes: f.sizeBytes ?? f.SizeBytes, uploadedUtc: toIso(u.created_at) });
    }
  } catch {}
  documents.sort((a, b) => new Date(b.uploadedUtc) - new Date(a.uploadedUtc));

  // Previously-submitted pre-approval.js inputs, so a returning borrower's "Update My
  // Information" visit starts from what they already entered instead of every field reverting to
  // blank. Best-effort: a parse failure just means no restore, never a hard error here.
  let formData = null;
  if (lead.form_data_json) {
    try { formData = JSON.parse(lead.form_data_json); } catch { formData = null; }
  }

  return ok({
    ok: true,
    status: lead.pre_approval_status || '',
    statusUpdatedUtc: toIso(lead.pre_approval_status_updated_at),
    // Included so the frontend's document-upload widget doesn't need a second lookup just to
    // fill in the borrowerName/email fields the upload endpoint requires.
    firstName: lead.first_name || '',
    lastName: lead.last_name || '',
    email: lead.email || '',
    // Lets the frontend know the loaded email is already E-SIGN-verified, so it doesn't demand a
    // fresh code on an update where the borrower never touched the field.
    emailVerified: lead.esign_email_verified_at != null,
    formData,
    documents,
  });
}

// ---------- POST leads/estimate/quick-start ----------
// No-verification gate: capture full name + phone, create/refresh the lead, and mint a 7-day
// session token so the What's My Rate tool unlocks immediately (no OTP code step). Turnstile
// guards against bots; the value of the lead is self-selecting.

export async function quickStart(request, env) {
  const data = (await readJsonBody(request)) || {};

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!(await verifyTurnstile(data.turnstileToken, env.TURNSTILE_SECRET, clientIp))) return new Response(null, { status: 403 });

  const fullName = (data.fullName || '').trim();
  const phone = (data.phone || '').trim();
  const lang = langCode(data.lang);
  // Which tool started the lead: "estimate" (What's My Rate) or "pre-approval". Defaults to
  // estimate for back-compat; anything unrecognized is coerced to estimate.
  let source = (data.source || 'estimate').trim().toLowerCase();
  if (source !== 'pre-approval') source = 'estimate';

  if (!fullName) return badRequest('Your name is required.');
  if (countDigits(phone) < 7) return badRequest('A valid phone number is required.');
  if (fullName.length > 120 || phone.length > 40) return badRequest('One of the fields is too long.');

  const now = nowSeconds();
  const sessionToken = crypto.randomUUID().replace(/-/g, '');
  const sessionExpiresAt = now + SESSION_DAYS * 86400;
  const { first, last } = splitName(fullName);

  // Dedupe by phone so a repeat visit refreshes one lead row instead of spawning duplicates.
  const existingLead = await findLeadByPhone(env, phone);
  const leadId = existingLead ? existingLead.id : crypto.randomUUID().replace(/-/g, '');

  try {
    if (!existingLead) {
      await env.DB.prepare(
        `INSERT INTO leads (id, first_name, last_name, phone, lang, created_at, updated_at, updated_by, session_token, session_expires_at, status, source, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system (quick-start)', ?, ?, 'New', ?, 0)`
      ).bind(leadId, first, last, phone, lang, now, now, sessionToken, sessionExpiresAt, source).run();
    } else {
      await env.DB.prepare(
        `UPDATE leads SET first_name=?, last_name=?, phone=?, lang=?, updated_at=?, updated_by='system (quick-start)', session_token=?, session_expires_at=? WHERE id=?`
      ).bind(first, last, phone, lang, now, sessionToken, sessionExpiresAt, leadId).run();
    }
  } catch (e) {
    console.error(`EstimateGate: quick-start lead store failed — ${e.message}`);
    return json({ error: 'Could not start your estimate.' }, 500);
  }

  return ok({ ok: true, leadId, token: sessionToken, expiresMs: sessionExpiresAt * 1000 });
}
