// Port of Config/IncompleteNoticeAutoWithdraw.cs — Reg B §1002.9(c) closes the loop on Path A
// (Notice of Incompleteness — see leadPreApprovalStatus.js). A borrower told "we need more from
// you, respond by [date]" who never responds must eventually get a definite disposition, or the
// file just sits open forever as an undisclosed denial. Daily sweep, not a real-time check. Two
// independent buckets each run:
// - Overdue (incomplete_deadline_at has passed): close as Withdrawn, courtesy email to the
//   borrower (this is a withdrawal, not a denial — no ECOA reasons/boilerplate required).
// - Approaching (deadline within REMINDER_DAYS_BEFORE_DEADLINE, not yet warned): email the
//   business inbox a heads-up so there's still time to follow up before it auto-closes.
import { nowSeconds } from './http.js';
import { sendViaResend, signature, businessInbox } from './emailer.js';
import { NEEDS_MORE_INFO, WITHDRAWN } from './preApprovalStatus.js';

// How far ahead of the deadline the business inbox gets a heads-up email — chosen so there's
// still real time to follow up with the borrower before the file auto-closes.
export const REMINDER_DAYS_BEFORE_DEADLINE = 3;

function ymd(epochSeconds) {
  if (epochSeconds == null) return '';
  const d = new Date(epochSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------- pure helpers (unit-tested) ----------

export function findOverdue(candidates, nowEpoch) {
  return (candidates || []).filter((l) =>
    !l.deleted && l.pre_approval_status === NEEDS_MORE_INFO &&
    l.incomplete_deadline_at != null && l.incomplete_deadline_at <= nowEpoch);
}

// Deadline still in the future but within REMINDER_DAYS_BEFORE_DEADLINE, and not already warned —
// a persisted "already warned" flag rather than an exact "days remaining == N" check, so a run
// that gets delayed or skips a day can't cause either a repeat email or a silently-missed warning.
export function findApproachingDeadline(candidates, nowEpoch) {
  return (candidates || []).filter((l) =>
    !l.deleted && l.pre_approval_status === NEEDS_MORE_INFO &&
    l.incomplete_deadline_at != null && l.incomplete_deadline_at > nowEpoch &&
    l.incomplete_deadline_at <= nowEpoch + REMINDER_DAYS_BEFORE_DEADLINE * 86400 &&
    l.incomplete_reminder_sent_at == null);
}

// Courtesy close-out — not itself a required ECOA notice (this is a withdrawal, not an adverse
// action), so no reason checklist here.
export function buildWithdrawnEmail(lead) {
  const es = (lead.lang || '').toLowerCase().startsWith('es');
  const name = (lead.first_name || '').trim();
  const sig = signature(es ? 'es' : 'en');

  if (es) {
    const greeting = name.length > 0 ? `Hola ${name}:` : 'Hola:';
    return {
      subject: '[LoanTechies] Tu solicitud fue cerrada por falta de respuesta',
      body: `${greeting}\n\nAnteriormente te pedimos información o documentos adicionales para continuar con tu solicitud de pre-aprobación, pero no hemos tenido noticias tuyas. ` +
        'Como no recibimos una respuesta, hemos cerrado tu solicitud y la consideramos retirada.\n\n' +
        'Esto no es una denegación de crédito — simplemente cerramos el archivo por falta de información. Puedes volver a presentar tu solicitud en cualquier momento subiendo tus documentos nuevamente en el portal.\n\n' +
        sig,
    };
  }

  const greetEn = name.length > 0 ? `Hi ${name},` : 'Hi,';
  return {
    subject: '[LoanTechies] Your request was closed for no response',
    body: `${greetEn}\n\nWe previously asked for additional information or documents to move your pre-approval request forward, but haven't heard back from you. ` +
      "Since we didn't receive a response, we've closed your request and are treating it as withdrawn.\n\n" +
      "This isn't a denial of credit — we're simply closing the file for lack of information. You're welcome to reapply anytime by uploading your documents again through the portal.\n\n" +
      sig,
  };
}

// Internal heads-up to the business inbox only — the borrower doesn't get a separate email here
// (they already have the original Needs More Info notice stating the deadline).
export function buildApproachingSummaryEmail(approaching) {
  let out = `${approaching.length} pre-approval request(s) still need a response within the next ${REMINDER_DAYS_BEFORE_DEADLINE} days, or they'll auto-withdraw for an unanswered Notice of Incompleteness.\n\n`;
  const sorted = [...approaching].sort((a, b) => (a.incomplete_deadline_at || 0) - (b.incomplete_deadline_at || 0));
  for (const l of sorted) {
    const name = `${l.first_name || ''} ${l.last_name || ''}`.trim();
    out += `  - ${name.length > 0 ? name : l.email} — lead id ${l.id} — deadline ${ymd(l.incomplete_deadline_at)}\n`;
  }
  out += '\nView in admin → Leads to follow up or extend by setting Needs More Info again.\n';
  return out;
}

function buildWithdrawnSummaryEmail(withdrawn) {
  let out = `${withdrawn.length} pre-approval request(s) were auto-withdrawn today — each had an unanswered Notice of Incompleteness past its deadline.\n\n`;
  for (const l of withdrawn) {
    const name = `${l.first_name || ''} ${l.last_name || ''}`.trim();
    out += `  - ${name.length > 0 ? name : l.email} — lead id ${l.id} — notice sent ${ymd(l.incomplete_notice_at)}, deadline was ${ymd(l.incomplete_deadline_at)}\n`;
  }
  out += '\nView in admin → Leads.\n';
  return out;
}

// ---------- called by the daily cron ----------

async function processOverdue(env, candidates, now) {
  const overdue = findOverdue(candidates, now);
  if (overdue.length === 0) {
    console.log('IncompleteNoticeAutoWithdraw: no overdue notices.');
    return;
  }

  const withdrawn = [];
  for (const lead of overdue) {
    try {
      await env.DB.prepare(
        `UPDATE leads SET pre_approval_status = ?, pre_approval_status_updated_at = ?, updated_at = ?, updated_by = 'system (incomplete-notice-deadline)' WHERE id = ?`
      ).bind(WITHDRAWN, now, now, lead.id).run();
      withdrawn.push(lead);
    } catch (e) {
      console.warn(`IncompleteNoticeAutoWithdraw: save failed for lead ${lead.id} — ${e.message}`);
      continue;
    }
    if (lead.email && lead.email.trim()) {
      const { subject, body } = buildWithdrawnEmail(lead);
      const sent = await sendViaResend(env, lead.email, subject, body);
      if (!sent) console.warn(`IncompleteNoticeAutoWithdraw: borrower email did not send for lead ${lead.id} (status saved).`);
    }
  }

  console.log(`IncompleteNoticeAutoWithdraw: auto-withdrew ${withdrawn.length} lead(s).`);
  const to = businessInbox(env);
  if (withdrawn.length > 0 && to) {
    await sendViaResend(env, to, `[LoanTechies] ${withdrawn.length} pre-approval request(s) auto-withdrawn (unanswered incompleteness notice)`, buildWithdrawnSummaryEmail(withdrawn));
  }
}

async function processApproaching(env, candidates, now) {
  const approaching = findApproachingDeadline(candidates, now);
  if (approaching.length === 0) {
    console.log('IncompleteNoticeAutoWithdraw: no deadlines approaching.');
    return;
  }

  const warned = [];
  for (const lead of approaching) {
    try {
      await env.DB.prepare('UPDATE leads SET incomplete_reminder_sent_at = ? WHERE id = ?').bind(now, lead.id).run();
      warned.push(lead);
    } catch (e) {
      console.warn(`IncompleteNoticeAutoWithdraw: reminder-flag save failed for lead ${lead.id} — ${e.message}`);
    }
  }

  const to = businessInbox(env);
  if (warned.length > 0 && to) {
    await sendViaResend(env, to, `[LoanTechies] ${warned.length} pre-approval request(s) closing soon (incompleteness deadline within ${REMINDER_DAYS_BEFORE_DEADLINE} days)`, buildApproachingSummaryEmail(warned));
  }
}

export async function run(env) {
  let candidates;
  try {
    const { results } = await env.DB.prepare('SELECT * FROM leads WHERE pre_approval_status = ?').bind(NEEDS_MORE_INFO).all();
    candidates = results || [];
  } catch (e) {
    console.warn(`IncompleteNoticeAutoWithdraw: leads query failed — ${e.message}`);
    return;
  }

  const now = nowSeconds();
  await processOverdue(env, candidates, now);
  await processApproaching(env, candidates, now);
}
