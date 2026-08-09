// Port of Loans/RateAlert.cs — Rate Watch: borrowers subscribe to a target rate and get one email
// when the current rate reaches it. Evaluated by the 5-min cron (see index.js's scheduled()).
import { ok, badRequest, nowSeconds } from './http.js';
import { verifyTurnstile } from './auth.js';
import { sendViaResend, langCode } from './emailer.js';
import { getQuote } from './loanFactoryRatesProvider.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';

// ---------- pure helpers ----------

export function shouldNotify(currentRate, targetRate) {
  return currentRate > 0 && targetRate > 0 && currentRate <= targetRate;
}

export function programLabel(term, refi) {
  const p = term === 15 ? '15-year fixed' : term === 7 ? '7-year ARM' : term === 5 ? '5-year ARM' : '30-year fixed';
  return p + (refi ? ' (refinance)' : ' (purchase)');
}

const ALERT_SIG = '- Anand V., NMLS #2471270';

export function buildSetEmail(code, label, targetRate, unsub) {
  const c = langCode(code);
  const rate = trimNum(targetRate);
  if (c === 'es')
    return {
      subject: 'Tu alerta de tasa de Loan Techies está activa',
      body: '¡Listo!\n\n' +
        `Te enviaremos un correo en cuanto la tasa ${label} llegue a ${rate}% o menos.\n\n` +
        'Calcula cuando quieras en https://www.loantechies.com\n\n' +
        ALERT_SIG + '\n\n' +
        `¿No quieres esta alerta? Cancela la suscripción: ${unsub}`,
    };
  if (c === 'hi')
    return {
      subject: 'Aapka Loan Techies rate alert set ho gaya',
      body: 'Sab set hai!\n\n' +
        `Jaise hi ${label} rate ${rate}% ya usse kam ho jaayegi, hum aapko email karenge.\n\n` +
        'Kabhi bhi https://www.loantechies.com par numbers calculate karein\n\n' +
        ALERT_SIG + '\n\n' +
        `Yeh alert nahi chahiye? Unsubscribe: ${unsub}`,
    };
  if (c === 'te')
    return {
      subject: 'Mee Loan Techies rate alert set ayyindi',
      body: 'Anni set ayyaayi!\n\n' +
        `${label} rate ${rate}% ki leda antakanna takkuva ki cheraganae, memu meeku email chestaamu.\n\n` +
        'Eppudaina https://www.loantechies.com lo numbers calculate cheyandi\n\n' +
        ALERT_SIG + '\n\n' +
        `Ee alert vaddaa? Unsubscribe: ${unsub}`,
    };
  return {
    subject: 'Your Loan Techies rate alert is set',
    body: "You're all set!\n\n" +
      `We'll email you as soon as the ${label} rate reaches ${rate}% or lower.\n\n` +
      'Run the numbers anytime at https://www.loantechies.com\n\n' +
      ALERT_SIG + '\n\n' +
      `Don't want this alert? Unsubscribe: ${unsub}`,
  };
}

export function buildHitEmail(code, label, currentRate, targetRate, unsub) {
  const c = langCode(code);
  const cur = trimNum(currentRate);
  const tgt = trimNum(targetRate);
  if (c === 'es')
    return {
      subject: `Las tasas alcanzaron tu objetivo - ${label} en ${cur}%`,
      body: '¡Buenas noticias! Las tasas alcanzaron tu objetivo.\n\n' +
        `La tasa ${label} ahora es de aproximadamente ${cur}%, igual o por debajo del ${tgt}% que vigilabas.\n\n` +
        'Es un buen momento para hablar de asegurarla. Responde a este correo o visita https://www.loantechies.com\n\n' +
        ALERT_SIG + '\n\n' +
        `(Tú configuraste esta alerta. Cancela la suscripción: ${unsub})`,
    };
  if (c === 'hi')
    return {
      subject: `Rates aapke target par - ${label} ${cur}% par`,
      body: 'Acchi khabar - rates abhi aapke target par aa gayi!\n\n' +
        `${label} rate ab lagbhag ${cur}% hai, jo aapke watch kiye ${tgt}% ke barabar ya usse kam hai.\n\n` +
        'Ise lock karne ke baare mein baat karne ka yeh accha samay hai. Is email ka reply karein ya https://www.loantechies.com par jaayein\n\n' +
        ALERT_SIG + '\n\n' +
        `(Aapne yeh rate alert set kiya tha. Unsubscribe: ${unsub})`,
    };
  if (c === 'te')
    return {
      subject: `Rates mee target ki cherayi - ${label} ${cur}% daggara`,
      body: 'Manchi varta - rates ippude mee target ki cheraayi!\n\n' +
        `${label} rate ippudu daadaapu ${cur}%, meeru watch chestunna ${tgt}% ki samaanam leda antakanna takkuva.\n\n` +
        'Deenini lock cheyadam gurinchi maatladataaniki idi manchi samayam. Ee email ki reply cheyandi leda https://www.loantechies.com ni sandarshinchandi\n\n' +
        ALERT_SIG + '\n\n' +
        `(Meeru ee rate alert set chesaaru. Unsubscribe: ${unsub})`,
    };
  return {
    subject: `Rates hit your target - ${label} at ${cur}%`,
    body: 'Good news - rates just hit your target!\n\n' +
      `The ${label} rate is now about ${cur}%, at or below the ${tgt}% you were watching.\n\n` +
      'This is a great time to talk through locking it in. Reply to this email or visit https://www.loantechies.com\n\n' +
      ALERT_SIG + '\n\n' +
      `(You set this rate alert. Unsubscribe: ${unsub})`,
  };
}

function trimNum(v) {
  // Mirrors C#'s "0.###" format — up to 3 decimals, trailing zeros trimmed.
  return String(Math.round(v * 1000) / 1000);
}

function unsubUrl(env, token) {
  const origin = env.PUBLIC_SITE_ORIGIN || 'https://www.loantechies.com';
  return `${origin}/api/loans/ratealert/unsubscribe?token=${token}`;
}

// ---------- storage ----------

// Persist a new active rate alert and (optionally) email the confirmation. Shared by the public
// subscribe endpoint and the (not-yet-migrated) admin "add alert" console endpoint.
export async function createAlert(env, { email, term, refinance, targetRate, lang, sendConfirmation }) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const code = langCode(lang);
  const now = nowSeconds();

  await env.DB.prepare(
    `INSERT INTO rate_alerts (id, email, term, refinance, target_rate, active, created_at, lang) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, email.trim(), term, refinance ? 1 : 0, targetRate, now, code).run();

  let sent = false;
  if (sendConfirmation) {
    const { subject, body } = buildSetEmail(code, programLabel(term, refinance), targetRate, unsubUrl(env, id));
    sent = await sendViaResend(env, email.trim(), subject, body, env.INQUIRY_TO_EMAIL || env.GMAIL_USER);
  }
  return { id, confirmationSent: sent };
}

// ---------- POST loans/ratealert : subscribe ----------

export async function subscribeRateAlert(request, env) {
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
  const term = Number(data.term) || 0;
  const refinance = !!data.refinance;
  const targetRate = Number(data.targetRate) || 0;
  const lang = data.lang;

  if (!email || !email.includes('@') || email.length > 254) return badRequest('A valid email is required.');
  // ARM (7/5-yr) is no longer supported for new alerts — no reliable live ARM rate source since
  // the LoanFactory migration (matches the estimate flow's own ARM eligibility block).
  if (term !== 30 && term !== 15) return badRequest('Invalid loan program.');
  if (targetRate <= 0 || targetRate > 25) return badRequest('Target rate must be between 0 and 25.');

  try {
    await createAlert(env, { email, term, refinance, targetRate, lang, sendConfirmation: true });
  } catch (e) {
    console.error(`RateAlert store failed: ${e.message}`);
    return new Response(JSON.stringify({ error: 'Could not save your alert.' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  return ok({ ok: true });
}

// ---------- GET loans/ratealert/unsubscribe?token= ----------

export async function unsubscribeRateAlert(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (token) {
    try {
      await env.DB.prepare('UPDATE rate_alerts SET active = 0 WHERE id = ?').bind(token).run();
    } catch (e) {
      console.error(`RateAlert unsubscribe failed: ${e.message}`);
    }
  }

  const html =
    "<html><body style='font-family:sans-serif;text-align:center;padding:60px;color:#1e293b'>" +
    '<h2>You\'re unsubscribed</h2>' +
    "<p>You won't receive that rate alert anymore.<br>Set a new one anytime at " +
    "<a href='https://www.loantechies.com' style='color:#4f46e5'>loantechies.com</a>.</p>" +
    '</body></html>';
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
}

// ---------- called by the 5-min cron ----------

// Notify (once) any active alert whose target rate has been met.
export async function evaluateAndNotify(env) {
  let rows;
  try {
    const { results } = await env.DB.prepare('SELECT * FROM rate_alerts WHERE active = 1').all();
    rows = results || [];
  } catch (e) {
    console.error(`RateAlert query failed: ${e.message}`);
    return;
  }

  const cfg = await loadRateConfig(env);
  const rateCache = new Map();

  for (const e of rows) {
    try {
      if (e.term !== 30 && e.term !== 15) {
        console.warn(`RateAlert: skipping unsupported ARM alert ${e.id} (term ${e.term}) — no live ARM rate source since the LoanFactory migration.`);
        continue;
      }

      const key = `${e.term}:${e.refinance}`;
      let current = rateCache.get(key);
      if (current == null) {
        if (!cfg) continue; // matches the C#'s implicit skip when RateConfigStore.LoadAsync returns null
        const quote = await getQuote('Conventional', 'Primary Residence', e.term, !!e.refinance, cfg, env);
        current = quote.rate;
        rateCache.set(key, current);
      }
      if (!shouldNotify(current, e.target_rate)) continue;

      const label = programLabel(e.term, !!e.refinance);
      const { subject, body } = buildHitEmail(e.lang, label, current, e.target_rate, unsubUrl(env, e.id));
      const sent = await sendViaResend(env, e.email, subject, body);
      if (sent) {
        await env.DB.prepare('UPDATE rate_alerts SET active = 0, notified_at = ? WHERE id = ?').bind(nowSeconds(), e.id).run();
        console.log(`Rate alert fired for ${e.email} (${key}) at ${current}%.`);
      }
    } catch (err) {
      console.error(`RateAlert eval error for ${e.id}: ${err.message}`);
    }
  }
}
