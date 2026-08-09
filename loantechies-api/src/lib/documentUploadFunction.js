// Port of Loans/DocumentUploadFunction.cs — public, Turnstile-gated endpoint for the secure
// document-upload portal (loantechies.com/upload-documents, and the pre-approval flow). Replaces
// "email your documents to me" — files go straight to a private R2 bucket instead of a mailbox.
//
// DELIBERATE DEVIATION from the C#'s streaming design, documented here because the C#'s own doc
// comment spent a full paragraph on why it mattered there: the C# used a raw MultipartReader over
// the request stream specifically to avoid ASP.NET's req.ReadFormAsync()/IFormFile, which spills
// large uploads to the Azure Function host's local temp disk — storage this app doesn't control,
// for financial documents. That specific risk has no equivalent on Workers: there is no local
// filesystem to spill to at all (V8 isolate memory is the only place bytes can live either way).
// So this port uses the Workers-native `request.formData()` (which fully parses the body into
// File/Blob objects in isolate memory — well within the 60 MB per-submission cap and the 128 MB
// isolate limit) and passes each File directly to `env.DOCUMENTS.put()`, which R2 streams from
// the Blob without an extra JS-side copy. What's preserved from the original: every file is still
// validated (extension, size, PDF magic-byte check) before any R2 write; nothing lands anywhere
// outside R2 + D1; cleanup on partial failure still runs. What's NOT reproduced: FileGuardStream's
// mid-read incremental abort — unnecessary here since formData() already gives real, fully-known
// file sizes up front rather than a live byte count against an untrusted Content-Length.
//
// All-or-nothing: every file must upload successfully before the D1 row is written, so no
// admin-visible submission is ever missing files and no notification fires for a broken upload.
// See adminDocumentUploads.js for the retrieval side.
//
// Optionally accepts a leadId+token pair (the same session pair as leads/estimate/save) — when
// present and valid, the upload is linked to that lead and, since arriving documents is itself
// meaningful progress, the lead's pre_approval_status auto-advances to "Documents Received"
// (never downgrading a status already moved forward). Anonymous uploads (no session) work exactly
// as before — this is purely additive.
import { json, ok, unauthorized, nowSeconds } from './http.js';
import { verifyTurnstile } from './auth.js';
import { sendViaResend, businessInbox } from './emailer.js';
import { isAtLeast, DOCUMENTS_RECEIVED } from './preApprovalStatus.js';
import {
  MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES,
  validateFields, isAllowedExtension, isPdfExtension, looksLikeValidPdf, sanitizeFileName,
  buildNotificationEmailBody, buildBorrowerConfirmationBody,
} from './documentUpload.js';

class DocumentUploadValidationError extends Error {}

async function validateLeadSession(env, leadId, token) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return null;
  const now = nowSeconds();
  if (lead.session_token !== token || now >= (lead.session_expires_at ?? -Infinity)) return null;
  return lead;
}

// Only ever moves forward: a lead already at "Under Review" or later stays there — arriving docs
// shouldn't regress a status already set.
async function advanceToDocumentsReceived(env, lead) {
  if (isAtLeast(lead.pre_approval_status, DOCUMENTS_RECEIVED)) return;
  const now = nowSeconds();
  await env.DB.prepare('UPDATE leads SET pre_approval_status = ?, pre_approval_status_updated_at = ? WHERE id = ?')
    .bind(DOCUMENTS_RECEIVED, now, lead.id).run();
}

async function cleanupUploaded(env, keys) {
  for (const key of keys) {
    try {
      await env.DOCUMENTS.delete(key);
    } catch (e) {
      console.warn(`DocumentUpload: cleanup failed for ${key} — ${e.message}`);
    }
  }
}

function str(v) {
  return v == null ? '' : v.toString();
}

export async function uploadDocument(request, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data'))
    return json({ errors: ['Expected a multipart form submission.'] }, 400);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ errors: ['Expected a multipart form submission.'] }, 400);
  }

  const borrowerName = str(form.get('borrowerName')).trim();
  const email = str(form.get('email')).trim();
  const phone = str(form.get('phone')).trim();
  const purpose = str(form.get('purpose')).trim();
  const turnstileToken = str(form.get('turnstileToken'));
  const leadId = str(form.get('leadId')).trim();
  const sessionToken = str(form.get('token')).trim();

  if (!turnstileToken) return json({ errors: ['Missing verification token.'] }, 400);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!(await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, clientIp))) return new Response(null, { status: 403 });

  let linkedLead = null;
  if (leadId) {
    linkedLead = await validateLeadSession(env, leadId, sessionToken);
    if (!linkedLead) return unauthorized();
  }

  const fieldErrors = validateFields(borrowerName, email, phone, purpose);
  if (fieldErrors.length > 0) return json({ errors: fieldErrors }, 400);

  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
  if (files.length === 0) return json({ errors: ['At least one file is required.'] }, 400);
  if (files.length > MAX_FILES) return json({ errors: [`No more than ${MAX_FILES} files per submission.`] }, 400);

  const submissionId = crypto.randomUUID().replace(/-/g, '');
  const uploadedKeys = [];
  const fileMetas = [];
  let totalBytes = 0;

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const fileName = file.name && file.name.trim() ? file.name : `file${fileIndex}`;

      if (!isAllowedExtension(fileName))
        throw new DocumentUploadValidationError(`"${fileName}" — file type not allowed (PDF, JPG, PNG, or HEIC only).`);
      if (file.size > MAX_FILE_BYTES)
        throw new DocumentUploadValidationError(`"${fileName}" — file is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB per file).`);
      if (file.size <= 0)
        throw new DocumentUploadValidationError(`"${fileName}" — file is empty.`);

      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new DocumentUploadValidationError(`Total upload size too large (max ${MAX_TOTAL_BYTES / 1024 / 1024} MB per submission).`);

      if (isPdfExtension(fileName)) {
        const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
        if (!looksLikeValidPdf(header)) throw new DocumentUploadValidationError(`"${fileName}" — doesn't look like a valid PDF.`);
      }

      const sanitized = sanitizeFileName(fileName);
      const key = `${submissionId}/${fileIndex}-${sanitized}`;
      const fileContentType = file.type || 'application/octet-stream';

      await env.DOCUMENTS.put(key, file, { httpMetadata: { contentType: fileContentType } });
      uploadedKeys.push(key);
      fileMetas.push({ fileName, r2Key: key, contentType: fileContentType, sizeBytes: file.size });
    }

    const now = nowSeconds();
    await env.DB.prepare(
      `INSERT INTO document_uploads (id, borrower_name, email, phone, purpose, created_at, files_json, file_count, total_size_bytes, lead_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      submissionId, borrowerName, email, phone, purpose, now,
      JSON.stringify(fileMetas), fileMetas.length, totalBytes, linkedLead ? linkedLead.id : null
    ).run();

    // Best-effort: a failure here shouldn't undo the (already durably saved) upload.
    if (linkedLead) {
      try {
        await advanceToDocumentsReceived(env, linkedLead);
      } catch (e) {
        console.warn(`DocumentUpload: status advance failed for lead ${linkedLead.id} — ${e.message}`);
      }
    }

    // The files+row are already safely stored at this point — that's the compliance win this
    // endpoint exists for. Both emails below are best-effort notifications, not the critical
    // send: a submission should never fail once its data is durably persisted.
    const notified = await sendViaResend(
      env, businessInbox(env), `[LoanTechies] New secure document upload — ${borrowerName}`,
      buildNotificationEmailBody({ borrowerName, purpose, fileCount: fileMetas.length, totalSizeBytes: totalBytes, createdAt: now })
    );
    if (!notified) console.warn(`DocumentUpload: admin notification did not send (submission ${submissionId} saved).`);

    if (email) {
      const sent = await sendViaResend(env, email, 'We received your documents — Loan Techies', buildBorrowerConfirmationBody({ borrowerName }, fileMetas.length));
      if (!sent) console.warn('DocumentUpload: borrower confirmation did not send (submission saved).');
    }

    return ok({ ok: true, submissionId, fileCount: fileMetas.length });
  } catch (e) {
    await cleanupUploaded(env, uploadedKeys);
    if (e instanceof DocumentUploadValidationError) return json({ errors: [e.message] }, 400);
    console.error(`DocumentUpload: failed for submission ${submissionId} — ${e.message}`);
    return json({ errors: ['Could not complete the upload. Please try again.'] }, 500);
  }
}
