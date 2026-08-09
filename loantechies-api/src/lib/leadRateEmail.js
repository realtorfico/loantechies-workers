// Port of Admin/LeadRateEmail.cs — "email current rate" for selected leads (admin only) plus the
// public unsubscribe link those emails carry. The rate is computed per lead from its stored
// scenario with the SAME engine as loans/estimatedrate (par + config deltas), so the number a
// lead receives always matches what the public site would show them.
import { ok, badRequest, unauthorized, json, readJsonBody, nowSeconds, toIso } from './http.js';
import { requireAccess } from './auth.js';
import { sendViaResend, langCode } from './emailer.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';
import { evaluateEligibility, computeLlpaDelta, computeGovAdj, computeCltvAdj } from './rateConfig.js';
import { getQuote } from './loanFactoryRatesProvider.js';
import { roundHalfEven } from './mathRound.js';
import { signature } from './emailer.js';

const MAX_BATCH = 100;

// ---------- LeadRateScenario: a lead's pricing scenario reconstructed from stored data ----------
// The What's My Rate autosave (form_data_json) when present, else the admin-entered CRM fields
// (crm_json). Pure + testable; a non-null `error` means the lead can't be priced (the admin UI
// shows the reason).

function makeScenario(fields) {
  return {
    ...fields,
    get ltv() { return this.homeValue > 0 ? (this.loan1 / this.homeValue) * 100 : 0; },
    get cltv() { return this.homeValue > 0 ? ((this.loan1 + this.loan2) / this.homeValue) * 100 : 0; },
  };
}

function fail(why) {
  return makeScenario({ refinance: false, loanType: 'Conventional', term: 30, occupancy: 'Primary Residence', creditLabel: null, homeValue: 0, loan1: 0, loan2: 0, error: why });
}

function firstNonEmpty(a, b) {
  return !a || !String(a).trim() ? b : String(a).trim();
}

// Tolerant money parse: accepts numbers or strings with $ , and spaces. Numeric JSON tokens pass
// through unchecked (even negative); only string-parsed values are rejected if negative — mirrors
// the C# original's JToken-type-dependent behavior exactly.
export function money(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\$/g, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseTerm(t) {
  let v = 0;
  if (typeof t === 'number') v = Math.trunc(t);
  else if (typeof t === 'string') v = parseInt(t, 10) || 0;
  return v === 30 || v === 15 || v === 7 || v === 5 ? v : 30;
}

// Numeric score -> the LLPA grid tier label (conservative tier below the grid floor).
export function creditTierFor(score) {
  if (score >= 780) return '780+';
  for (const floor of [760, 740, 720, 700, 680, 660, 640, 620]) {
    if (score >= floor) return `${floor}-${floor + 19}`;
  }
  return '620-639';
}

function tryParse(json) {
  if (!json || !String(json).trim()) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function validate(s, sourceLabel) {
  if (!s.creditLabel || !String(s.creditLabel).trim()) return fail(`missing credit score (${sourceLabel})`);
  if (s.homeValue <= 0) return fail(`missing property value (${sourceLabel})`);
  if (s.loan1 <= 0) return fail(`missing loan amount (${sourceLabel})`);
  return s;
}

// What's My Rate autosave: { purpose, loanType, term, occupancy, inputs:{...} }.
function fromFormData(jsonStr) {
  const f = tryParse(jsonStr);
  if (!f) return null;
  const inputs = f.inputs && typeof f.inputs === 'object' ? f.inputs : null;

  const refinance = String(f.purpose || '').toLowerCase() === 'refinance';
  const loanType = firstNonEmpty(f.loanType, 'Conventional');
  const term = parseTerm(f.term);
  const occupancy = firstNonEmpty(f.occupancy, 'Primary Residence');
  const creditLabel = inputs && inputs.credit != null ? String(inputs.credit).trim() : null;

  const price = money(inputs?.price);
  const value = money(inputs?.value);
  const down = money(inputs?.downPayment);
  const bal = money(inputs?.currentBalance);
  const loan2 = money(inputs?.loan2);

  const homeValue = refinance ? value : price;
  const loan1 = refinance ? bal : Math.max(price - down, 0);

  return validate(makeScenario({ refinance, loanType, term, occupancy, creditLabel, homeValue, loan1, loan2 }), "What's My Rate data");
}

// Admin-entered CRM fields: purpose, propertyValue, loanAmount/downPayment, creditScore.
function fromCrm(jsonStr) {
  const c = tryParse(jsonStr);
  if (!c) return null;

  const refinance = String(c.purpose || '').toLowerCase().includes('refi');
  const homeValue = money(c.propertyValue);
  const loanAmt = money(c.loanAmount);
  const down = money(c.downPayment);
  const loan1 = loanAmt > 0 ? loanAmt : (homeValue > 0 && down > 0 ? Math.max(homeValue - down, 0) : 0);

  const creditRaw = c.creditScore != null ? String(c.creditScore).trim() : null;
  const score = creditRaw != null && creditRaw !== '' ? Number(creditRaw) : NaN;
  const creditLabel = Number.isFinite(score) ? creditTierFor(score) : creditRaw;

  return validate(makeScenario({ refinance, loanType: 'Conventional', term: 30, occupancy: 'Primary Residence', creditLabel, homeValue, loan1, loan2: 0 }), 'CRM fields');
}

export function fromLead(formDataJson, crmJson) {
  const fromForm = fromFormData(formDataJson);
  if (fromForm) return fromForm;
  const fromCrmResult = fromCrm(crmJson);
  if (fromCrmResult) return fromCrmResult;
  return fail('no saved scenario (no What\'s My Rate data and no CRM loan details)');
}

export function termLabel(term) {
  if (term === 30) return '30-Yr Fixed';
  if (term === 15) return '15-Yr Fixed';
  if (term === 7) return '7-Yr ARM';
  if (term === 5) return '5-Yr ARM';
  return `${term}-Yr`;
}

// ---------- email text (en/es + romanized hi/te, matching the RateAlert email style) ----------

function money0(v) {
  return Math.round(v).toLocaleString('en-US');
}
function fmt1(v) {
  let s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
function fmt3(v) {
  let s = v.toFixed(3).replace(/0+$/, '');
  return s.endsWith('.') ? s.slice(0, -1) : s;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatAsOf(date) {
  const mon = MONTHS[date.getUTCMonth()];
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${date.getUTCDate()}, ${date.getUTCFullYear()} ${hh}:${mm} UTC`;
}

// code is already-normalized (en/es/hi/te) — callers pass langCode(lead.lang).
export function buildEmail(code, firstName, sc, rate, apr, asOfUtc, unsub) {
  const label = termLabel(sc.term);
  const purpose = sc.refinance ? 'Refinance' : 'Purchase';
  const rateStr = fmt3(rate);
  const aprStr = apr != null ? fmt3(apr) : null;
  const headline = `    ${label} (${purpose}): ${rateStr}%` + (aprStr != null ? `  (APR ~${aprStr}%)` : '');
  const asOf = formatAsOf(asOfUtc);

  const assumptions =
    `- Loan type: ${sc.loanType}\n` +
    `- ${sc.refinance ? 'Home value' : 'Purchase price'}: $${money0(sc.homeValue)}\n` +
    `- Loan amount: $${money0(sc.loan1)}` + (sc.loan2 > 0 ? ` (+ $${money0(sc.loan2)} second lien)` : '') + '\n' +
    `- Loan-to-value: ${fmt1(sc.ltv)}%\n` +
    `- Credit: ${sc.creditLabel}\n` +
    `- Occupancy: ${sc.occupancy}`;

  const hi = !firstName || !String(firstName).trim() ? 'Hi' : `Hi ${String(firstName).trim()}`;
  const sig = signature(code);

  if (code === 'es')
    return {
      subject: `Tu tasa estimada de hoy - ${label} en ${rateStr}%`,
      body: `Hola${!firstName || !String(firstName).trim() ? '' : ' ' + String(firstName).trim()},\n\n` +
        'Esta es tu tasa estimada de hoy, basada en los datos que compartiste con nosotros:\n\n' +
        headline + '\n\n' +
        'Este estimado asume:\n' + assumptions + '\n\n' +
        `Las tasas cambian a diario; esta se calculó el ${asOf}. Es un estimado educativo - no es una cotización ni un compromiso de préstamo.\n\n` +
        '¿Quieres números exactos para tu situación? Responde a este correo o visita https://www.loantechies.com\n\n' +
        sig + '\n\n' +
        `¿Prefieres no recibir actualizaciones de tasas? Cancela aquí: ${unsub}`,
    };
  if (code === 'hi')
    return {
      subject: `Aaj ki aapki estimated rate - ${label} ${rateStr}% par`,
      body: `${hi},\n\n` +
        'Aapke share kiye gaye details ke aadhar par, yeh hai aaj ki aapki estimated rate:\n\n' +
        headline + '\n\n' +
        'Yeh estimate in details par aadharit hai:\n' + assumptions + '\n\n' +
        `Rates roz badalti hain; yeh ${asOf} par calculate hui thi. Yeh sirf educational estimate hai - quote ya loan commitment nahi.\n\n` +
        'Apni situation ke exact numbers chahiye? Is email ka reply karein ya https://www.loantechies.com par jaayein\n\n' +
        sig + '\n\n' +
        `Rate updates nahi chahiye? Unsubscribe: ${unsub}`,
    };
  if (code === 'te')
    return {
      subject: `Mee nedu estimated rate - ${label} ${rateStr}% daggara`,
      body: `${hi},\n\n` +
        'Meeru share chesina details aadharanga, idi mee nedu estimated rate:\n\n' +
        headline + '\n\n' +
        'Ee estimate ee details meeda aadharapadi undi:\n' + assumptions + '\n\n' +
        `Rates pratiroju maaruthayi; idi ${asOf} ki calculate ayyindi. Idi educational estimate maatrame - quote leda loan commitment kaadu.\n\n` +
        'Mee situation ki exact numbers kavala? Ee email ki reply cheyandi leda https://www.loantechies.com ni sandarshinchandi\n\n' +
        sig + '\n\n' +
        `Rate updates vaddaa? Unsubscribe: ${unsub}`,
    };
  return {
    subject: `Your current estimated rate - ${label} at ${rateStr}%`,
    body: `${hi},\n\n` +
      "Here is today's estimated rate, based on the details you shared with us:\n\n" +
      headline + '\n\n' +
      'This estimate assumes:\n' + assumptions + '\n\n' +
      `Rates move daily; this one was computed on ${asOf}. It is an educational estimate only - not a quote, a pre-qualification, or a commitment to lend.\n\n` +
      'Want exact numbers for your situation? Just reply to this email or visit https://www.loantechies.com\n\n' +
      sig + '\n\n' +
      `Prefer not to receive rate updates? Unsubscribe: ${unsub}`,
  };
}

function unsubUrl(env, token) {
  const origin = env.PUBLIC_SITE_ORIGIN || 'https://www.loantechies.com';
  return `${origin}/api/leads/email/unsubscribe?token=${token}`;
}

// ---------- POST console/leads/email-rate (Access-gated) ----------
// { leadIds: [...], dryRun: true|false }. dryRun renders everything (rate + the exact email text)
// without sending — powers the admin preview modal. Per-lead results carry ok/sent/skip-reason so
// one bad lead never blocks the rest.

function round4(v) {
  return roundHalfEven(v, 4);
}
function round1(v) {
  return roundHalfEven(v, 1);
}

function skip(id, name, email, reason) {
  return { id, name, email, ok: false, sent: false, reason };
}

async function getPar(cache, cfg, loanType, occupancy, refinance, term, env) {
  const key = `${loanType}|${occupancy}|${refinance}|${term}`;
  if (cache.has(key)) return cache.get(key);
  const quote = await getQuote(loanType, occupancy, term, refinance, cfg, env);
  const v = { rate: quote.rate, apr: quote.apr, fallback: quote.source === 'config-fallback' };
  cache.set(key, v);
  return v;
}

export async function emailRate(request, env) {
  const adminEmail = await requireAccess(request, env);
  if (!adminEmail) return unauthorized();

  const data = (await readJsonBody(request)) || {};
  const ids = [...new Set((Array.isArray(data.leadIds) ? data.leadIds : []).filter((x) => x && String(x).trim()).map((x) => String(x).trim()))];
  if (ids.length === 0) return badRequest('Select at least one lead.');
  if (ids.length > MAX_BATCH) return badRequest(`At most ${MAX_BATCH} leads per send.`);

  const cfg = await loadRateConfig(env);
  if (!cfg) return json({ error: 'Estimated-rate config is missing — open Rate Settings once to seed it.' }, 503);

  const nowUtc = new Date();
  const now = nowSeconds();
  const parCache = new Map();
  const results = [];

  for (const id of ids) {
    let name = '', leadEmail = '';
    try {
      const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();
      if (!lead) { results.push(skip(id, name, leadEmail, 'lead not found')); continue; }
      name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
      leadEmail = lead.email || '';
      if (lead.deleted) { results.push(skip(id, name, leadEmail, 'lead is deleted')); continue; }
      if (lead.no_email) { results.push(skip(id, name, leadEmail, 'opted out of emails')); continue; }
      if (!lead.email || !lead.email.trim()) { results.push(skip(id, name, leadEmail, 'no email address')); continue; }

      const sc = fromLead(lead.form_data_json, lead.crm_json);
      if (sc.error) { results.push(skip(id, name, leadEmail, sc.error)); continue; }

      const ineligible = evaluateEligibility(cfg, {
        creditLabel: sc.creditLabel, ltv: sc.ltv, cltv: sc.cltv, occupancy: sc.occupancy, loanType: sc.loanType, term: sc.term, refinance: sc.refinance,
      });
      if (ineligible != null) { results.push(skip(id, name, leadEmail, 'not priced — ' + ineligible)); continue; }

      const creditForLookup = sc.creditLabel === 'Not sure' ? '640-659' : sc.creditLabel;
      const delta = computeLlpaDelta(cfg, creditForLookup, sc.ltv, sc.loanType)
        + computeGovAdj(cfg, creditForLookup, sc.ltv, sc.loanType)
        + computeCltvAdj(cfg, sc.ltv, sc.cltv);

      const par = await getPar(parCache, cfg, sc.loanType, sc.occupancy, sc.refinance, sc.term, env);
      const rate = round4(par.rate + delta);
      const apr = par.fallback || par.apr == null ? null : round4(par.apr + delta);

      // The unsubscribe link must resolve from the moment the email lands, so the token is
      // persisted BEFORE sending.
      let unsubToken = lead.unsubscribe_token;
      if (!unsubToken && !data.dryRun) {
        unsubToken = crypto.randomUUID().replace(/-/g, '');
        await env.DB.prepare('UPDATE leads SET unsubscribe_token = ? WHERE id = ?').bind(unsubToken, id).run();
      }
      const unsub = unsubUrl(env, unsubToken || '(created-on-send)');
      const { subject, body: text } = buildEmail(langCode(lead.lang), lead.first_name, sc, rate, apr, nowUtc, unsub);

      if (data.dryRun) {
        results.push({
          id, name, email: leadEmail, ok: true, sent: false, rate, apr,
          product: termLabel(sc.term), purpose: sc.refinance ? 'Refinance' : 'Purchase',
          loanType: sc.loanType, ltv: round1(sc.ltv), cltv: round1(sc.cltv),
          credit: sc.creditLabel, occupancy: sc.occupancy, fallback: par.fallback, subject, body: text,
        });
        continue;
      }

      const sent = await sendViaResend(env, lead.email.trim(), subject, text);
      if (!sent) { results.push(skip(id, name, leadEmail, 'send failed (see backend log)')); continue; }

      try {
        await env.DB.prepare('UPDATE leads SET last_rate_email_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(now, now, adminEmail, id).run();
      } catch (e) {
        console.warn(`LeadRateEmail: sent to ${leadEmail} but stamp failed — ${e.message}`);
      }
      results.push({ id, name, email: leadEmail, ok: true, sent: true, rate, apr, product: termLabel(sc.term), fallback: par.fallback });
    } catch (e) {
      console.error(`LeadRateEmail: lead ${id} failed — ${e.message}`);
      results.push(skip(id, name, leadEmail, 'unexpected error (see backend log)'));
    }
  }

  return ok({ asOfUtc: nowUtc.toISOString(), dryRun: !!data.dryRun, results });
}

// ---------- leads/email/unsubscribe?token= (public, from the email link) ----------
// Two-step on purpose: the link in the email is a GET, which only renders a confirmation page (NO
// database write). Email clients / link scanners / prefetchers issue GET, so they can never
// silently unsubscribe a lead. The opt-out happens only when the human clicks the button, which
// POSTs the token back (form-encoded). Same route, branched on method.

function unsubscribePage(inner) {
  return new Response(
    "<html><body style='font-family:sans-serif;text-align:center;padding:60px;color:#1e293b'>" + inner + '</body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } }
  );
}

export async function unsubscribeLeadEmail(request, env) {
  const isPost = request.method === 'POST';
  let token;
  if (isPost) {
    try {
      const form = await request.formData();
      token = (form.get('token') || '').toString().trim();
    } catch {
      token = '';
    }
  } else {
    token = (new URL(request.url).searchParams.get('token') || '').trim();
  }
  const validToken = token.length >= 16; // GUID "N" is 32 chars; reject junk early

  if (!isPost) {
    const origin = env.PUBLIC_SITE_ORIGIN || 'https://www.loantechies.com';
    return unsubscribePage(
      validToken
        ? '<h2>Unsubscribe from rate emails?</h2>' +
          '<p>Click below to stop receiving estimated-rate update emails from us.</p>' +
          `<form method='post' action='${origin}/api/leads/email/unsubscribe'>` +
          `<input type='hidden' name='token' value='${htmlEncode(token)}'>` +
          "<button type='submit' style='background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer'>Unsubscribe</button>" +
          '</form>'
        : '<h2>Link expired</h2><p>This unsubscribe link is no longer valid. Reply to any of our emails to opt out.</p>'
    );
  }

  // POST -> actually opt the lead out.
  if (validToken) {
    try {
      await env.DB.prepare("UPDATE leads SET no_email = 1, updated_at = ?, updated_by = 'system (unsubscribe)' WHERE unsubscribe_token = ?")
        .bind(nowSeconds(), token).run();
    } catch (e) {
      console.error(`Lead email unsubscribe failed: ${e.message}`);
    }
  }

  return unsubscribePage(
    "<h2>You're unsubscribed</h2>" +
    "<p>You won't receive rate update emails from us anymore.<br>Check rates anytime at " +
    "<a href='https://www.loantechies.com' style='color:#4f46e5'>loantechies.com</a>.</p>"
  );
}

function htmlEncode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
