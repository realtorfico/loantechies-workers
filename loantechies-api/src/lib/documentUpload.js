// Port of Loans/DocumentUpload.cs's DocumentUploadValidation — pure, testable validation +
// sanitization for document uploads, plus the (also pure) admin-notification / borrower-
// confirmation email builders from Loans/DocumentUploadFunction.cs. No env/HTTP dependency — see
// documentUploadFunction.js for the route handler.
export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB per file
// 60 MB per submission — not simply MAX_FILES*MAX_FILE_BYTES, a separate cap forces realistic
// mixed-size submissions rather than letting every slot be maxed out.
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic']);

export const MAX_NAME_LENGTH = 150;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PHONE_LENGTH = 40;
const ALLOWED_PURPOSES = new Set(['purchase', 'refinance', 'not sure', '']);

// Name/email/phone/purpose only — split out so the upload handler can validate the text fields as
// soon as they've arrived, before it touches any file.
export function validateFields(borrowerName, email, phone, purpose) {
  const errors = [];

  if (!borrowerName || !borrowerName.trim()) errors.push('Full name is required.');
  else if (borrowerName.length > MAX_NAME_LENGTH) errors.push(`Full name must be ${MAX_NAME_LENGTH} characters or fewer.`);

  if (!email || !email.includes('@')) errors.push('A valid email address is required.');
  else if (email.length > MAX_EMAIL_LENGTH) errors.push(`Email must be ${MAX_EMAIL_LENGTH} characters or fewer.`);

  if ((phone?.length ?? 0) > MAX_PHONE_LENGTH) errors.push(`Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`);

  if (!ALLOWED_PURPOSES.has((purpose || '').toLowerCase())) errors.push('Purpose must be Purchase, Refinance, Not sure, or left blank.');

  return errors;
}

function extOf(fileName) {
  const m = /\.[^./\\]+$/.exec(fileName || '');
  return m ? m[0].toLowerCase() : '';
}

export function isAllowedExtension(fileName) {
  return ALLOWED_EXTENSIONS.has(extOf(fileName));
}

export function isPdfExtension(fileName) {
  return extOf(fileName) === '.pdf';
}

// Cheap magic-byte check — a real PDF starts with "%PDF-". Not a full parse, just enough to catch
// a renamed non-PDF.
export function looksLikeValidPdf(headerBytes) {
  if (!headerBytes || headerBytes.length < 5) return false;
  let prefix = '';
  for (let i = 0; i < 5; i++) prefix += String.fromCharCode(headerBytes[i]);
  return prefix === '%PDF-';
}

// Strips path separators/control chars and caps length — defense in depth for the R2 key, not a
// UX feature (the admin UI always shows the original fileName).
export function sanitizeFileName(fileName) {
  if (!fileName || !fileName.trim()) return 'file';
  let cleaned = '';
  for (const c of fileName) {
    if (/[a-zA-Z0-9._\- ]/.test(c)) cleaned += c;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) cleaned = 'file';
  return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
}

// Validates the whole batch up front — used by tests. The live handler (documentUploadFunction.js)
// checks each file as it's processed instead (same outcomes, see that file's own doc comment for
// why it doesn't need FileGuardStream-style mid-stream guarding the way the C# did).
export function validate(borrowerName, email, phone, purpose, files) {
  const errors = validateFields(borrowerName, email, phone, purpose);

  if (!files || files.length === 0) {
    errors.push('At least one file is required.');
    return errors; // no point validating individual files further
  }
  if (files.length > MAX_FILES) errors.push(`No more than ${MAX_FILES} files per submission.`);

  let total = 0;
  for (const f of files) {
    total += f.sizeBytes;
    if (!isAllowedExtension(f.fileName)) errors.push(`"${f.fileName}" — file type not allowed (PDF, JPG, PNG, or HEIC only).`);
    if (f.sizeBytes > MAX_FILE_BYTES) errors.push(`"${f.fileName}" — file is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB per file).`);
    if (f.sizeBytes <= 0) errors.push(`"${f.fileName}" — file is empty.`);
    if (isPdfExtension(f.fileName) && !looksLikeValidPdf(f.headerBytes)) errors.push(`"${f.fileName}" — doesn't look like a valid PDF.`);
  }
  if (total > MAX_TOTAL_BYTES) errors.push(`Total upload size too large (max ${MAX_TOTAL_BYTES / 1024 / 1024} MB per submission).`);

  return errors;
}

// ---------- email bodies (pure, public for testing) ----------

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${fmt1(mb)} MB`;
  return `${fmt1(bytes / 1024)} KB`;
}
function fmt1(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatSubmittedDate(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DOW[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()} ${h}:${mm} ${ampm}`;
}

// Pure and exported for testing — this is the one place in the whole feature where an instinct to
// "include everything useful" would quietly recreate the original email-PII problem. Deliberately
// excludes email, phone, and file names. entity: { borrowerName, purpose, fileCount,
// totalSizeBytes, createdAt (epoch seconds) }.
export function buildNotificationEmailBody(entity) {
  const purpose = entity.purpose && entity.purpose.trim() ? entity.purpose : 'Not specified';
  return 'A borrower uploaded documents securely through the Loan Techies portal.\n\n' +
    `Name: ${entity.borrowerName}\n` +
    `Purpose: ${purpose}\n` +
    `Files: ${entity.fileCount} file(s), ${formatBytes(entity.totalSizeBytes)} total\n` +
    `Submitted: ${formatSubmittedDate(entity.createdAt)} UTC\n\n` +
    'Review and download the files from your dashboard:\n' +
    'https://admin.loantechies.com/#/uploads\n\n' +
    'This is an automated notification. Contact details and the files themselves are only\n' +
    'available in the dashboard above (not included here).';
}

export function buildBorrowerConfirmationBody(entity, fileCount) {
  return `Hi ${entity.borrowerName},\n\n` +
    `We received your ${fileCount} document(s). Anand will review them and follow up if anything else is needed.\n\n` +
    '— Anand V., Mortgage Loan Originator, NMLS #2471270';
}
