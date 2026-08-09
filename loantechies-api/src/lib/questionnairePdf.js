// Port of Loans/QuestionnairePdfBuilder.cs — builds a cover page (return-to email from
// QuestionnaireConfig, loan-originator info from ContactConfig) and prepends it to the static
// base questionnaire PDF. Generated fresh per request rather than baked into the static file, so
// the return email can change without re-uploading a PDF.
//
// IMPORTANT deviation from the C# port pattern used everywhere else in this migration: the base
// PDFs (assets/questionnaires/*.pdf) are NOT plain documents — pre-check found they're fillable
// AcroForms (137/139 form fields). pdf-lib's PDFDocument.copyPages() (the natural translation of
// PdfSharpCore's PdfReader.Open + AddPage loop) silently drops the destination document's
// AcroForm dictionary — verified empirically: a copyPages-merged doc round-tripped through
// save+reload has ZERO form fields, even though the base doc alone has 137. The fix is to load
// the BASE document itself (which already owns an intact AcroForm) and INSERT the cover page at
// index 0, rather than building a fresh document and copying the base pages into it — verified
// this preserves all 137/139 fields through save+reload. See test-questionnairepdf.mjs's
// "preserves AcroForm fields" cases — this is the one property this port checks that the
// original C# test suite didn't need to (PdfSharpCore's page-import path doesn't have this
// failure mode).
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Hardcoded, matching the existing convention for cross-service URLs elsewhere in this codebase.
const UPLOAD_DOCUMENTS_BASE_URL = 'https://www.loantechies.com/upload-documents/';

const PAGE_WIDTH = 612; // US Letter, points (8.5in * 72dpi)
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75"

const INDIGO = rgb(79 / 255, 70 / 255, 229 / 255);
const GRAY = rgb(75 / 255, 85 / 255, 99 / 255);
const LIGHT_GRAY = rgb(243 / 255, 244 / 255, 246 / 255);
const BLACK = rgb(0, 0, 0);

// Simple greedy word-wrap using font.widthOfTextAtSize — good enough for the one or two lines the
// instructions box needs; not a general-purpose typesetting routine.
function wrapText(font, size, text, maxWidth) {
  const lines = [];
  const words = text.split(' ');
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : current + ' ' + word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function originatorLines(contact) {
  const lines = ['Anand V. — Mortgage Loan Originator', 'NMLS #2471270 | CA-DRE #02208256 | Loan Factory, CA'];
  if (contact) {
    if (contact.callEnabled && contact.phone && contact.phone.trim()) lines.push(`Phone: ${contact.phone}`);
    if (contact.whatsappEnabled && contact.whatsapp && contact.whatsapp.trim()) lines.push(`WhatsApp: ${contact.whatsapp}`);
    if (contact.calendlyEnabled && contact.calendlyUrl && contact.calendlyUrl.trim()) lines.push(`Schedule a call: ${contact.calendlyUrl}`);
  }
  return lines;
}

// pdf-lib's coordinate system is bottom-up (y increases toward the top of the page); the layout
// below is written top-down (matching the C#'s XGraphics convention, y increases toward the
// bottom) for a straightforward line-by-line port — every drawText/drawRectangle call converts
// its top-down baseline/edge via toPdfY(topDownY) = PAGE_HEIGHT - topDownY right at the call site.
function addCoverPage(page, fontRegular, fontBold, refi, returnEmail, contact) {
  const margin = MARGIN;
  const width = PAGE_WIDTH - 2 * margin;
  const toPdfY = (topDownY) => PAGE_HEIGHT - topDownY;

  let y = margin;

  page.drawText('LOAN TECHIES', { x: margin, y: toPdfY(y + 22), size: 22, font: fontBold, color: INDIGO });
  y += 44;

  const subject = refi ? 'Refinance Questionnaire' : 'Purchase Questionnaire';
  page.drawText(subject, { x: margin, y: toPdfY(y + 18), size: 16, font: fontBold, color: BLACK });
  y += 40;

  // Instructions callout box. Height is computed from the actual wrapped line counts (not a
  // fixed constant) since content length varies — the secondary email line only renders when an
  // admin return email is configured, and the primary instruction is long enough to wrap
  // regardless.
  const innerWidth = width - 32;
  const purposeParam = refi ? 'Refinance' : 'Purchase';
  const primaryText = `Upload the completed form securely at: ${UPLOAD_DOCUMENTS_BASE_URL}?purpose=${purposeParam}`;
  const primaryLines = wrapText(fontBold, 11, primaryText, innerWidth);

  const bodyText = "Fill it out completely and save it before uploading. You'll also be asked for " +
    'supporting documents (pay stubs, bank statements, tax returns) — your loan originator will ' +
    "let you know what's needed.";
  const bodyTextLines = wrapText(fontRegular, 11, bodyText, innerWidth);

  let secondaryLines = [];
  if (returnEmail && returnEmail.trim())
    secondaryLines = wrapText(fontRegular, 9, `Prefer email? You can also send the completed form to: ${returnEmail}`, innerWidth);

  let ty = 22; // running offset from the box's top edge (y)
  ty += 20; // header baseline -> first content line
  ty += primaryLines.length * 16;
  ty += 4;
  ty += bodyTextLines.length * 16;
  if (secondaryLines.length > 0) ty += 6 + secondaryLines.length * 14;
  const boxHeight = ty + 12;

  page.drawRectangle({ x: margin, y: toPdfY(y + boxHeight), width, height: boxHeight, color: LIGHT_GRAY });
  ty = y + 22;
  page.drawText('How to return this form', { x: margin + 16, y: toPdfY(ty), size: 11, font: fontBold, color: BLACK });
  ty += 20;
  for (const line of primaryLines) {
    page.drawText(line, { x: margin + 16, y: toPdfY(ty), size: 11, font: fontBold, color: INDIGO });
    ty += 16;
  }
  ty += 4;
  for (const line of bodyTextLines) {
    page.drawText(line, { x: margin + 16, y: toPdfY(ty), size: 11, font: fontRegular, color: GRAY });
    ty += 16;
  }
  if (secondaryLines.length > 0) {
    ty += 6;
    for (const line of secondaryLines) {
      page.drawText(line, { x: margin + 16, y: toPdfY(ty), size: 9, font: fontRegular, color: GRAY });
      ty += 14;
    }
  }
  y += boxHeight + 28;

  // Loan originator info.
  page.drawText('Your loan originator', { x: margin, y: toPdfY(y), size: 11, font: fontBold, color: BLACK });
  y += 20;
  for (const line of originatorLines(contact)) {
    page.drawText(line, { x: margin, y: toPdfY(y), size: 11, font: fontRegular, color: GRAY });
    y += 16;
  }

  const disclaimer = 'This is an educational tool only — completing this form is not an application, quote, or commitment to lend.';
  page.drawText(disclaimer, { x: margin, y: toPdfY(PAGE_HEIGHT - margin - 3), size: 9, font: fontRegular, color: GRAY });
}

export async function build(refi, basePdfBytes, returnEmail, contact, fontRegularBytes, fontBoldBytes) {
  const doc = await PDFDocument.load(basePdfBytes);
  doc.registerFontkit(fontkit);
  const fontRegular = await doc.embedFont(fontRegularBytes);
  const fontBold = await doc.embedFont(fontBoldBytes);

  const coverPage = doc.insertPage(0, [PAGE_WIDTH, PAGE_HEIGHT]);
  addCoverPage(coverPage, fontRegular, fontBold, refi, returnEmail, contact);

  return doc.save();
}
