// Port of Utils/EmailResults.cs — POST utils/emailresults, "email me my results". Emails a
// borrower the calculator numbers they just ran, and optionally drops the MLO a soft lead.
import { verifyTurnstile } from './auth.js';
import { sendViaResend, langCode, signature } from './emailer.js';

function textResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function emailResults(request, env) {
  let data;
  try {
    data = JSON.parse(await request.text());
  } catch {
    data = null;
  }
  data = data || {};

  const email = data.email;
  const name = data.name;
  const lang = data.lang;
  const title = data.title;
  const summary = data.summary;
  const copyToMlo = !!data.copyToMlo;

  const clientIp = request.headers.get('CF-Connecting-IP');
  const turnstileOk = await verifyTurnstile(data.turnstileToken, env.TURNSTILE_SECRET, clientIp);
  if (!turnstileOk) return new Response(null, { status: 403 });

  if (!email || !email.includes('@') || email.length > 254)
    return textResp('A valid email address is required.', 400);

  if ((name?.length ?? 0) > 200 || (title?.length ?? 0) > 200 || (summary?.length ?? 0) > 1000)
    return textResp('Input too long.', 400);

  const rows = [];
  if (Array.isArray(data.rows)) {
    for (const r of data.rows) {
      let label = r?.label != null ? String(r.label) : '';
      let value = r?.value != null ? String(r.value) : '';
      if (label.length > 120) label = label.slice(0, 120);
      if (value.length > 120) value = value.slice(0, 120);
      rows.push({ label, value });
      if (rows.length >= 40) break;
    }
  }

  const { subject, body } = buildResultsEmail(name, lang, title, summary, rows);
  const sent = await sendViaResend(env, email, subject, body);
  if (!sent) return textResp('Could not send the email.', 400);

  // Optional soft lead: let the MLO know a borrower saved these numbers. Best-effort — the
  // borrower already got their copy; don't fail on this.
  if (copyToMlo) {
    const inquiryTo = env.INQUIRY_TO_EMAIL || env.GMAIL_USER;
    if (inquiryTo) {
      const leadBody =
        'A borrower emailed themselves their results from Loan Techies and asked you to follow up.\n\n' +
        `Name: ${name?.trim() ? name : '(not provided)'}\n` +
        `Email: ${email}\n\n` +
        `${title?.trim() ? title : 'Result'}\n` +
        `${summary}\n` +
        (rows.length > 0 ? '\n' + rows.map((r) => `${r.label}: ${r.value}`).join('\n') : '');
      const mloSent = await sendViaResend(env, inquiryTo, `New Loan Techies lead: ${name} emailed their results`, leadBody);
      if (!mloSent) console.warn('emailResults: MLO lead copy did not send (borrower copy already delivered).');
    }
  }

  return textResp('Results emailed.');
}

// Builds the borrower-facing "your results" email. Pure, side-effect-free.
export function buildResultsEmail(name, lang, title, summary, rows) {
  const code = langCode(lang);
  const who = (name || '').trim();
  const head = title?.trim() ? title.trim() : code === 'es' ? 'Tus resultados' : 'Your results';
  const rowsText = rows && rows.length > 0 ? rows.map((r) => `${r.label}: ${r.value}`).join('\n') + '\n\n' : '';

  if (code === 'es') {
    const greeting = who ? `Hola ${who}:` : 'Hola:';
    return {
      subject: 'Tus resultados hipotecarios de Loan Techies',
      body: `${greeting}\n\n` +
        'Aquí están los números que acabas de calcular en Loan Techies:\n\n' +
        `${head}\n` +
        (summary?.trim() ? `${summary}\n` : '') +
        '\n' + rowsText +
        'Estas cifras son estimaciones con fines educativos únicamente y no constituyen un compromiso de préstamo. ' +
        'Responde a este correo cuando quieras y te ayudaré a convertirlas en una cotización real.\n\n' +
        'Saludos,\n\n' +
        signature('es'),
    };
  }
  if (code === 'hi') {
    const greeting = who ? `Namaste ${who},` : 'Namaste,';
    return {
      subject: 'Loan Techies se aapke mortgage results',
      body: `${greeting}\n\n` +
        'Yeh wo numbers hain jo aapne abhi Loan Techies par calculate kiye:\n\n' +
        `${head}\n` +
        (summary?.trim() ? `${summary}\n` : '') +
        '\n' + rowsText +
        'Yeh figures sirf educational purpose ke liye estimates hain, koi loan commitment nahi. ' +
        'Kabhi bhi is email ka reply karein aur main inhe ek real quote mein badalne mein aapki madad karunga.\n\n' +
        'Jaldi baat karte hain,\n\n' +
        signature('hi'),
    };
  }
  if (code === 'te') {
    const greeting = who ? `Namaste ${who},` : 'Namaste,';
    return {
      subject: 'Loan Techies nunchi mee mortgage results',
      body: `${greeting}\n\n` +
        'Meeru ippude Loan Techies lo calculate chesina numbers ivi:\n\n' +
        `${head}\n` +
        (summary?.trim() ? `${summary}\n` : '') +
        '\n' + rowsText +
        'Ee figures kevalam educational purpose kosam estimates, ivi loan commitment kaadu. ' +
        'Eppudaina ee email ki reply cheyandi, vaatini oka real quote gaa maarchadaaniki nenu sahaayam chestaanu.\n\n' +
        'Twaralo maatladataam,\n\n' +
        signature('te'),
    };
  }

  const greetEn = who ? `Hi ${who},` : 'Hi there,';
  return {
    subject: 'Your mortgage results from Loan Techies',
    body: `${greetEn}\n\n` +
      'Here are the numbers you just ran on Loan Techies:\n\n' +
      `${head}\n` +
      (summary?.trim() ? `${summary}\n` : '') +
      '\n' + rowsText +
      'These figures are estimates for educational purposes only and not a commitment to lend. ' +
      "Reply to this email any time and I'll help you turn them into a real quote.\n\n" +
      'Talk soon,\n\n' +
      signature('en'),
  };
}
