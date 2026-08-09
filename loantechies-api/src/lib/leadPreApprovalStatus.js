// Port of Admin/LeadPreApprovalStatusApi.cs — Access-gated: admin sets the pre-approval status
// stages that require a human judgment call (Under Review / Needs More Info / Pre-Approved /
// Declined — see preApprovalStatus.js's ADMIN_SETTABLE). The system-set stages (Submitted,
// Documents Received) are NOT settable here — driven by the borrower's own actions
// (estimateGate.js's saveLead / the Phase-4 document upload handler). Withdrawn is likewise not
// settable here — see the Phase-3 daily IncompleteNoticeAutoWithdraw sweep. Sends the borrower a
// status-specific email on every change.
//
// Reg B §1002.9 closure paths (see memory: loantechies-compliance-review-2026-07-18):
// - Declined = Path B, Adverse Action Notice. Requires >=1 reason from adverseActionReasons.js's
//   canonical (Model Form B-1) list — rejects anything not on that list rather than trusting free
//   text, since this becomes the operative legal disclosure. NOT LEGAL ADVICE — confirm the
//   reason list and notice boilerplate below with Anand / Loan Factory compliance before relying
//   on this for a real declination.
// - Needs More Info = Path A, Notice of Incompleteness. Stamps a 30-day deadline
//   (INCOMPLETE_NOTICE_DEADLINE_DAYS); the daily auto-withdraw sweep withdraws a lead still
//   sitting here once the deadline passes.
import { ok, badRequest, notFound, unauthorized, json, readJsonBody, nowSeconds, toIso } from './http.js';
import { requireAccess } from './auth.js';
import { sendViaResend, signature } from './emailer.js';
import { ADMIN_SETTABLE, DECLINED, NEEDS_MORE_INFO, UNDER_REVIEW, PRE_APPROVED } from './preApprovalStatus.js';
import { isValid as isValidReason, toSpanish as reasonToSpanish } from './adverseActionReasons.js';

// Reg B §1002.9(c)(2) points to a "reasonable period of time" for a Notice of Incompleteness
// deadline; 30 days is CFPB's own commonly-cited reasonable figure.
export const INCOMPLETE_NOTICE_DEADLINE_DAYS = 30;

// Newtonsoft's dynamic JObject in the C# exposed a JSON array property directly enumerable; here
// `reasonsRaw` is already a plain JS array/undefined from JSON.parse. Dedupes and drops blanks;
// unknown-but-nonblank values are caught by the isValidReason check at the call site, not here.
function parseReasons(reasonsRaw) {
  const list = [];
  if (!Array.isArray(reasonsRaw)) return list;
  for (const r of reasonsRaw) {
    const s = (typeof r === 'string' ? r : String(r ?? '')).trim();
    if (s.length > 0 && !list.includes(s)) list.push(s);
  }
  return list;
}

// ---------- POST console/leads/pre-approval-status ----------

export async function setPreApprovalStatus(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const data = (await readJsonBody(request)) || {};
  const leadId = (data.leadId || '').trim();
  const status = (data.status || '').trim();

  if (!leadId || !ADMIN_SETTABLE.has(status))
    return badRequest('leadId is required and status must be one of: Under Review, Needs More Info, Pre-Approved, Declined.');

  let reasons = null;
  if (status === DECLINED) {
    reasons = parseReasons(data.reasons);
    if (reasons.length === 0) return badRequest('At least one denial reason is required to decline.');
    const invalid = reasons.filter((r) => !isValidReason(r));
    if (invalid.length > 0) return badRequest('Unrecognized reason(s): ' + invalid.join(', '));
  }
  let note = (data.note || '').trim();
  if (note.length > 1000) note = note.slice(0, 1000);

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return notFound('Lead not found.');

  const now = nowSeconds();
  let deadlineAt = null;
  try {
    const fields = { pre_approval_status: status, pre_approval_status_updated_at: now, updated_at: now, updated_by: email };
    if (status === DECLINED) {
      fields.adverse_action_sent_at = now;
      fields.adverse_action_reasons_json = JSON.stringify(reasons);
    } else if (status === NEEDS_MORE_INFO) {
      fields.incomplete_notice_at = now;
      deadlineAt = now + INCOMPLETE_NOTICE_DEADLINE_DAYS * 86400;
      fields.incomplete_deadline_at = deadlineAt;
      fields.incomplete_notice_note = note || null;
    }
    await env.DB.prepare(
      `UPDATE leads SET
         pre_approval_status = ?, pre_approval_status_updated_at = ?, updated_at = ?, updated_by = ?,
         adverse_action_sent_at = COALESCE(?, adverse_action_sent_at),
         adverse_action_reasons_json = COALESCE(?, adverse_action_reasons_json),
         incomplete_notice_at = COALESCE(?, incomplete_notice_at),
         incomplete_deadline_at = COALESCE(?, incomplete_deadline_at),
         incomplete_notice_note = COALESCE(?, incomplete_notice_note)
       WHERE id = ?`
    ).bind(
      fields.pre_approval_status, fields.pre_approval_status_updated_at, fields.updated_at, fields.updated_by,
      fields.adverse_action_sent_at ?? null, fields.adverse_action_reasons_json ?? null,
      fields.incomplete_notice_at ?? null, fields.incomplete_deadline_at ?? null, fields.incomplete_notice_note ?? null,
      leadId
    ).run();
  } catch (e) {
    console.warn(`LeadPreApprovalStatus: save failed — ${e.message}`);
    return json({ error: 'Could not save.' }, 500);
  }

  let emailed = false;
  if (lead.email && lead.email.trim()) {
    const { subject, body } = buildStatusEmail(lead, status, note, deadlineAt, reasons);
    emailed = await sendViaResend(env, lead.email, subject, body);
    if (!emailed) console.warn(`LeadPreApprovalStatus: borrower email did not send for lead ${leadId} (status saved).`);
  }

  return ok({ ok: true, status, emailed, deadlineUtc: toIso(deadlineAt) });
}

// ---------- pure email builders (public for testing) ----------

// note/deadlineAt (epoch seconds) only apply to NeedsMoreInfo (Path A, Notice of Incompleteness);
// reasons only applies to Declined (Path B, Adverse Action Notice — delegates to
// buildAdverseActionEmail). Spanish when the lead's captured language starts with "es".
export function buildStatusEmail(lead, status, note = null, deadlineAt = null, reasons = null) {
  if (status === DECLINED) return buildAdverseActionEmail(lead, reasons || []);

  const es = (lead.lang || '').toLowerCase().startsWith('es');
  const name = (lead.first_name || '').trim();
  const sig = signature(es ? 'es' : 'en');

  if (es) {
    const greeting = name.length > 0 ? `Hola ${name}:` : 'Hola:';
    if (status === UNDER_REVIEW)
      return { subject: '[LoanTechies] Tu solicitud está en revisión',
        body: `${greeting}\n\nTu solicitud de pre-aprobación y tus documentos ya están en revisión. Te contactaré si necesito algo más.\n\n${sig}` };
    if (status === NEEDS_MORE_INFO) {
      let body = `${greeting}\n\nEstoy revisando tu solicitud y necesito información o documentos adicionales para continuar.`;
      if (note && note.trim()) body += `\n\nEspecíficamente, necesito: ${note}`;
      body += '\n\nPuedes subir documentos adicionales en cualquier momento desde el portal.';
      if (deadlineAt != null)
        body += `\n\nPor favor responde antes del ${formatDateEs(deadlineAt)} (hora del Pacífico). Si no tenemos noticias tuyas para esa fecha, consideraremos tu solicitud retirada y cerraremos el archivo — puedes volver a presentar tu solicitud en cualquier momento después.`;
      body += `\n\n${sig}`;
      return { subject: '[LoanTechies] Necesitamos algo más de ti', body };
    }
    if (status === PRE_APPROVED)
      return { subject: '[LoanTechies] ¡Estás pre-aprobado!',
        body: `${greeting}\n\n¡Buenas noticias! Tu pre-aprobación está lista. Te contactaré pronto con los detalles y los próximos pasos.\n\n${sig}` };
    return { subject: '[LoanTechies] Actualización de tu solicitud', body: `${greeting}\n\nEl estado de tu solicitud se actualizó a: ${status}\n\n${sig}` };
  }

  const greetEn = name.length > 0 ? `Hi ${name},` : 'Hi,';
  if (status === UNDER_REVIEW)
    return { subject: '[LoanTechies] Your request is under review',
      body: `${greetEn}\n\nYour pre-approval request and documents are now under review. I'll reach out if I need anything else.\n\n${sig}` };
  if (status === NEEDS_MORE_INFO) {
    let body = `${greetEn}\n\nI'm reviewing your request and need some additional information or documents to move forward.`;
    if (note && note.trim()) body += `\n\nSpecifically, I need: ${note}`;
    body += '\n\nYou can upload additional documents anytime through the portal.';
    if (deadlineAt != null)
      body += `\n\nPlease respond by ${formatDateEn(deadlineAt)} (Pacific time). If we haven't heard from you by then, we'll treat your request as withdrawn and close the file — you're welcome to reapply anytime after.`;
    body += `\n\n${sig}`;
    return { subject: '[LoanTechies] We need a bit more from you', body };
  }
  if (status === PRE_APPROVED)
    return { subject: "[LoanTechies] You're pre-approved!",
      body: `${greetEn}\n\nGreat news — your pre-approval is ready. I'll be in touch shortly with the details and next steps.\n\n${sig}` };
  return { subject: '[LoanTechies] Your request status was updated', body: `${greetEn}\n\nYour request status was updated to: ${status}\n\n${sig}` };
}

// The Reg B §1002.9(a)(2) Adverse Action Notice. Pure and exported for testing. NOT LEGAL ADVICE
// — see adverseActionReasons.js's module doc comment. The agency listed (CFPB) is the standard
// modern default for a non-bank mortgage originator under Reg B Appendix A; confirm it's correct
// for Loan Factory's specific structure before this notice goes to a real borrower.
export function buildAdverseActionEmail(lead, reasons) {
  const es = (lead.lang || '').toLowerCase().startsWith('es');
  const name = (lead.first_name || '').trim();
  const sig = signature(es ? 'es' : 'en');

  if (es) {
    const greeting = name.length > 0 ? `Hola ${name}:` : 'Hola:';
    const reasonLines = reasons.map((r) => '  - ' + reasonToSpanish(r)).join('\n');
    const body =
      `${greeting}\n\n` +
      'Gracias por solicitar crédito con nosotros. Hemos revisado cuidadosamente tu solicitud y no podemos aprobarla en este momento, por la(s) siguiente(s) razón(es):\n\n' +
      reasonLines + '\n\n' +
      'La Ley Federal de Igualdad de Oportunidades de Crédito (Equal Credit Opportunity Act) prohíbe a los acreedores discriminar a los solicitantes de crédito por motivos de raza, color, religión, origen nacional, sexo, estado civil o edad (siempre que el solicitante tenga capacidad legal para celebrar un contrato); porque la totalidad o parte de los ingresos del solicitante provenga de un programa de asistencia pública; o porque el solicitante haya ejercido de buena fe algún derecho bajo la Ley de Protección al Crédito del Consumidor. La agencia federal que supervisa el cumplimiento de esta ley con respecto a este acreedor es la Oficina de Protección Financiera del Consumidor (Consumer Financial Protection Bureau), 1700 G Street NW, Washington, DC 20552.\n\n' +
      'Si tienes preguntas sobre esta decisión, comunícate directamente con Anand usando la información de contacto a continuación.\n\n' +
      sig;
    return { subject: '[LoanTechies] Aviso importante sobre tu solicitud de crédito', body };
  }

  const greetEn = name.length > 0 ? `Hi ${name},` : 'Hi,';
  const reasonLinesEn = reasons.map((r) => '  - ' + r).join('\n');
  const bodyEn =
    `${greetEn}\n\n` +
    "Thank you for applying for credit with us. Your application has been carefully reviewed, and we're unable to approve your request at this time, for the following reason(s):\n\n" +
    reasonLinesEn + '\n\n' +
    "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, or age (provided the applicant has the capacity to enter into a binding contract); because all or part of the applicant's income derives from any public assistance program; or because the applicant has in good faith exercised any right under the Consumer Credit Protection Act. The federal agency that administers compliance with this law concerning this creditor is the Consumer Financial Protection Bureau, 1700 G Street NW, Washington, DC 20552.\n\n" +
    'If you have questions about this decision, please contact Anand directly using the information below.\n\n' +
    sig;
  return { subject: '[LoanTechies] Important notice about your credit application', body: bodyEn };
}

function formatDateEn(epochSeconds) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(epochSeconds * 1000));
}
function formatDateEs(epochSeconds) {
  return new Intl.DateTimeFormat('es-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(epochSeconds * 1000));
}
