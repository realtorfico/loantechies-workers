// Port of Loans/SavingsAlert.cs — Savings Watch: borrowers describe their current loan + a target
// monthly saving and get one email when the market refinance rate for the chosen program would
// lower their monthly P&I by at least that amount. Uses the generic Zillow getCurrentRates feed
// (VeryHigh credit / Normal LTV), same as the C# — indicative, not a personalized quote.
import { ok, badRequest, nowSeconds } from './http.js';
import { verifyTurnstile } from './auth.js';
import { sendViaResend, langCode } from './emailer.js';
import { getRate as getZillowRate } from './zillowCurrentRatesProvider.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';
import { programLabel as rateAlertProgramLabel } from './rateAlert.js';

// ---------- pure helpers ----------

// Level monthly principal & interest for a fully-amortizing loan.
export function monthlyPI(principal, annualRatePct, months) {
  if (principal <= 0 || months <= 0) return 0;
  const r = (annualRatePct / 100.0) / 12.0;
  if (r <= 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

// Monthly P&I saved by refinancing the current balance into the new program.
export function monthlySavings(balance, currentRatePct, yearsLeft, newRatePct, newTermYears) {
  const currentPI = monthlyPI(balance, currentRatePct, yearsLeft * 12);
  const newPI = monthlyPI(balance, newRatePct, newTermYears * 12);
  return currentPI - newPI;
}

export function shouldNotify(savings, targetSavings) {
  return savings > 0 && targetSavings > 0 && savings >= targetSavings;
}

// Reuse Rate Watch's program label so the wording stays consistent across both alerts.
export function programLabel(term) {
  return rateAlertProgramLabel(term, true);
}

const ALERT_SIG = '- Anand V., NMLS #2471270';

function money(v) {
  return '$' + Math.round(v).toLocaleString('en-US');
}

function trimNum(v) {
  return String(Math.round(v * 1000) / 1000);
}

export function buildSetEmail(code, label, targetSavings, unsub) {
  const c = langCode(code);
  const amt = money(targetSavings);
  if (c === 'es')
    return {
      subject: 'Tu alerta de ahorro de Loan Techies está activa',
      body: '¡Listo!\n\n' +
        `Te enviaremos un correo en cuanto refinanciar a ${label} pueda reducir tu pago mensual de capital e intereses en al menos ${amt}.\n\n` +
        'Calcula cuando quieras en https://www.loantechies.com\n\n' +
        ALERT_SIG + '\n\n' +
        `¿No quieres esta alerta? Cancela la suscripción: ${unsub}`,
    };
  if (c === 'hi')
    return {
      subject: 'Aapka Loan Techies savings alert set ho gaya',
      body: 'Sab set hai!\n\n' +
        `Jaise hi ${label} mein refinance karne se aapka monthly principal & interest payment kam se kam ${amt} kam ho sakega, hum aapko email karenge.\n\n` +
        'Kabhi bhi https://www.loantechies.com par numbers calculate karein\n\n' +
        ALERT_SIG + '\n\n' +
        `Yeh alert nahi chahiye? Unsubscribe: ${unsub}`,
    };
  if (c === 'te')
    return {
      subject: 'Mee Loan Techies savings alert set ayyindi',
      body: 'Anni set ayyaayi!\n\n' +
        `${label} ki refinance cheyadam valla mee nelavari principal & interest payment kaneesam ${amt} taggaganae, memu meeku email chestaamu.\n\n` +
        'Eppudaina https://www.loantechies.com lo numbers calculate cheyandi\n\n' +
        ALERT_SIG + '\n\n' +
        `Ee alert vaddaa? Unsubscribe: ${unsub}`,
    };
  return {
    subject: 'Your Loan Techies savings alert is set',
    body: "You're all set!\n\n" +
      `We'll email you as soon as refinancing to a ${label} could lower your monthly principal & interest payment by at least ${amt}.\n\n` +
      'Run the numbers anytime at https://www.loantechies.com\n\n' +
      ALERT_SIG + '\n\n' +
      `Don't want this alert? Unsubscribe: ${unsub}`,
  };
}

export function buildHitEmail(code, label, savings, newRate, unsub) {
  const c = langCode(code);
  const amt = money(savings);
  const rate = trimNum(newRate);
  if (c === 'es')
    return {
      subject: `Podrías ahorrar ${amt}/mes refinanciando`,
      body: '¡Buenas noticias! Las tasas se movieron a tu favor.\n\n' +
        `Refinanciar a ${label} (ahora alrededor de ${rate}%) podría reducir tu pago mensual de capital e intereses en aproximadamente ${amt}.\n\n` +
        'Es un buen momento para verlo en detalle. Responde a este correo o visita https://www.loantechies.com\n\n' +
        ALERT_SIG + '\n\n' +
        `(Tú configuraste esta alerta. Cancela la suscripción: ${unsub})`,
    };
  if (c === 'hi')
    return {
      subject: `Refinance karke aap ${amt}/mahina bacha sakte hain`,
      body: 'Acchi khabar - rates aapke favor mein aa gayi!\n\n' +
        `${label} mein refinance karne se (abhi lagbhag ${rate}%) aapka monthly principal & interest payment lagbhag ${amt} kam ho sakta hai.\n\n` +
        'Ise detail mein dekhne ka yeh accha samay hai. Is email ka reply karein ya https://www.loantechies.com par jaayein\n\n' +
        ALERT_SIG + '\n\n' +
        `(Aapne yeh savings alert set kiya tha. Unsubscribe: ${unsub})`,
    };
  if (c === 'te')
    return {
      subject: `Refinance dwara meeru nelaki ${amt} aadaa cheyochu`,
      body: 'Manchi varta - rates mee favor lo kadilaayi!\n\n' +
        `${label} ki refinance cheyadam valla (ippudu daadaapu ${rate}%) mee nelavari principal & interest payment daadaapu ${amt} taggochu.\n\n` +
        'Deenini vivaranga choodadaaniki idi manchi samayam. Ee email ki reply cheyandi leda https://www.loantechies.com ni sandarshinchandi\n\n' +
        ALERT_SIG + '\n\n' +
        `(Meeru ee savings alert set chesaaru. Unsubscribe: ${unsub})`,
    };
  return {
    subject: `You could save ${amt}/mo by refinancing`,
    body: 'Good news - rates moved in your favor!\n\n' +
      `Refinancing to a ${label} (now about ${rate}%) could lower your monthly principal & interest payment by roughly ${amt}.\n\n` +
      'This is a great time to talk through the details. Reply to this email or visit https://www.loantechies.com\n\n' +
      ALERT_SIG + '\n\n' +
      `(You set this savings alert. Unsubscribe: ${unsub})`,
  };
}

function unsubUrl(env, token) {
  const origin = env.PUBLIC_SITE_ORIGIN || 'https://www.loantechies.com';
  return `${origin}/api/loans/savingsalert/unsubscribe?token=${token}`;
}

// ---------- storage ----------

export async function createAlert(env, { email, balance, currentRate, yearsLeft, term, targetSavings, lang, sendConfirmation }) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const code = langCode(lang);
  const now = nowSeconds();

  await env.DB.prepare(
    `INSERT INTO savings_alerts (id, email, balance, current_rate, years_left, term, target_savings, active, created_at, lang) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, email.trim(), balance, currentRate, yearsLeft, term, targetSavings, now, code).run();

  let sent = false;
  if (sendConfirmation) {
    const { subject, body } = buildSetEmail(code, programLabel(term), targetSavings, unsubUrl(env, id));
    sent = await sendViaResend(env, email.trim(), subject, body, env.INQUIRY_TO_EMAIL || env.GMAIL_USER);
  }
  return { id, confirmationSent: sent };
}

// ---------- POST loans/savingsalert : subscribe ----------

export async function subscribeSavingsAlert(request, env) {
  let data;
  try {
    data = JSON.parse(await request.text());
  } catch {
    data = null;
  }
  data = data || {};

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!(await verifyTurnstile(data.turnstileToken, env.TURNSTILE_SECRET, clientIp))) return new Response(null, { status: 403 });

  const email = data.email;
  const balance = Number(data.balance) || 0;
  const currentRate = Number(data.currentRate) || 0;
  const yearsLeft = Number(data.yearsLeft) || 0;
  const term = Number(data.term) || 0;
  const targetSavings = Number(data.targetSavings) || 0;
  const lang = data.lang;

  if (!email || !email.includes('@') || email.length > 254) return badRequest('A valid email is required.');
  if (balance <= 0 || balance > 100_000_000) return badRequest('Enter your current loan balance.');
  if (currentRate <= 0 || currentRate > 25) return badRequest('Current rate must be between 0 and 25.');
  if (yearsLeft < 1 || yearsLeft > 40) return badRequest('Years left must be between 1 and 40.');
  if (term !== 30 && term !== 15 && term !== 7 && term !== 5) return badRequest('Invalid loan program.');
  if (targetSavings <= 0 || targetSavings > 100_000) return badRequest('Target monthly savings must be greater than 0.');

  try {
    await createAlert(env, { email, balance, currentRate, yearsLeft, term, targetSavings, lang, sendConfirmation: true });
  } catch (e) {
    console.error(`SavingsAlert store failed: ${e.message}`);
    return new Response(JSON.stringify({ error: 'Could not save your alert.' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  return ok({ ok: true });
}

// ---------- GET loans/savingsalert/unsubscribe?token= ----------

export async function unsubscribeSavingsAlert(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (token) {
    try {
      await env.DB.prepare('UPDATE savings_alerts SET active = 0 WHERE id = ?').bind(token).run();
    } catch (e) {
      console.error(`SavingsAlert unsubscribe failed: ${e.message}`);
    }
  }

  const html =
    "<html><body style='font-family:sans-serif;text-align:center;padding:60px;color:#1e293b'>" +
    '<h2>You\'re unsubscribed</h2>' +
    "<p>You won't receive that savings alert anymore.<br>Set a new one anytime at " +
    "<a href='https://www.loantechies.com' style='color:#4f46e5'>loantechies.com</a>.</p>" +
    '</body></html>';
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
}

// ---------- called by the 5-min cron ----------

// Notify (once) any active alert where refinancing now clears the target monthly saving.
export async function evaluateAndNotify(env) {
  let rows;
  try {
    const { results } = await env.DB.prepare('SELECT * FROM savings_alerts WHERE active = 1').all();
    rows = results || [];
  } catch (e) {
    console.error(`SavingsAlert query failed: ${e.message}`);
    return;
  }

  const cfg = await loadRateConfig(env);
  const rateCache = new Map();

  for (const e of rows) {
    try {
      let newRate = rateCache.get(e.term);
      if (newRate == null) {
        const { rate } = await getZillowRate('VeryHigh', 'Normal', e.term, true, cfg, env);
        newRate = rate;
        rateCache.set(e.term, newRate);
      }
      if (!(newRate > 0)) continue;

      const savings = monthlySavings(e.balance, e.current_rate, e.years_left, newRate, e.term);
      if (!shouldNotify(savings, e.target_savings)) continue;

      const label = programLabel(e.term);
      const { subject, body } = buildHitEmail(e.lang, label, savings, newRate, unsubUrl(env, e.id));
      const sent = await sendViaResend(env, e.email, subject, body);
      if (sent) {
        await env.DB.prepare('UPDATE savings_alerts SET active = 0, notified_at = ? WHERE id = ?').bind(nowSeconds(), e.id).run();
        console.log(`Savings alert fired for ${e.email} (term ${e.term}) at ${money(savings)}/mo.`);
      }
    } catch (err) {
      console.error(`SavingsAlert eval error for ${e.id}: ${err.message}`);
    }
  }
}
