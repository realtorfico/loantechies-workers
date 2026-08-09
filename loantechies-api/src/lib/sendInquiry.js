// Port of Utils/SendInquiry.cs — POST utils/sendinquiry, the site's contact-form handler.
// Sends a lead email to the MLO (the critical send), a best-effort borrower autoresponder in
// their language, and best-effort persists the inquiry to D1 for the admin dashboard. The
// frontend (core.js) only checks response.ok — doesn't parse the body — so the exact wire shape
// here doesn't need to match the C#'s bare-string OkObjectResult.
import { nowSeconds } from './http.js';
import { verifyTurnstile } from './auth.js';
import { sendViaResend, langCode, signature } from './emailer.js';

export async function sendInquiry(request, env) {
  let data;
  try {
    data = JSON.parse(await request.text());
  } catch {
    data = null;
  }
  data = data || {};

  const name = data.name;
  const email = data.email;
  const phone = data.phone;
  const source = data.source; // carries page + calculator scenario from the frontend
  const message = data.message;
  const zip = data.zip;
  const lang = data.lang;

  const clientIp = request.headers.get('CF-Connecting-IP');
  const turnstileOk = await verifyTurnstile(data.turnstileToken, env.TURNSTILE_SECRET, clientIp);
  if (!turnstileOk) return new Response(null, { status: 403 });

  if ((name?.length ?? 0) > 200 || (email?.length ?? 0) > 254 || (phone?.length ?? 0) > 40 ||
      (source?.length ?? 0) > 2000 || (message?.length ?? 0) > 5000 || (zip?.length ?? 0) > 12) {
    return new Response(JSON.stringify('Input too long.'), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const inquiryTo = env.INQUIRY_TO_EMAIL || env.GMAIL_USER;
  if (!inquiryTo) {
    console.error('sendInquiry: no business inbox configured (INQUIRY_TO_EMAIL / GMAIL_USER).');
    return new Response(JSON.stringify('Email service is not configured.'), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  const srcDisplay = source?.trim() ? source : '(not specified)';
  const leadBody = `Received: ${pacificNow()}\n\n` +
    `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
    (zip ? `ZIP: ${zip}\n` : '') +
    '\n' +
    `Source / scenario:\n${srcDisplay}` +
    (message ? `\n\nMessage:\n${message}` : '');

  // Lead to the MLO — the critical send.
  const sent = await sendViaResend(env, inquiryTo, `New Loan Inquiry from ${name}`, leadBody);
  if (!sent) {
    console.error('sendInquiry: lead email failed to send.');
    return new Response(JSON.stringify('Could not send the inquiry email.'), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  // Best-effort borrower autoresponder — never fails the request.
  if (email && email.includes('@')) {
    const { subject: acSubject, body: acBody } = buildAutoReply(name, lang);
    const acSent = await sendViaResend(env, email, acSubject, acBody);
    if (!acSent) console.warn('sendInquiry: borrower autoresponder did not send (lead delivered).');
  }

  // Best-effort: persist the inquiry so it shows up in the admin site. Never fails the request.
  try {
    const id = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(
      `INSERT INTO inquiries (id, name, email, phone, zip, source, message, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name || null, email || null, phone || null, zip || null, source || null, message || null, langCode(lang), nowSeconds()).run();
  } catch (e) {
    console.warn(`sendInquiry: inquiry persist failed (email unaffected): ${e.message}`);
  }

  return new Response(JSON.stringify('Email sent successfully'), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Builds the borrower-facing confirmation email. Pure, side-effect-free. Spanish/Hindi/Telugu
// when lang starts with es/hi/te (case-insensitive), English otherwise.
export function buildAutoReply(name, lang) {
  const code = langCode(lang);
  const who = (name || '').trim();

  if (code === 'es') {
    const greeting = who ? `Hola ${who}:` : 'Hola:';
    return {
      subject: 'Gracias por comunicarte con Loan Techies',
      body: `${greeting}\n\n` +
        'Gracias por comunicarte a través de Loan Techies. He recibido tu solicitud y me pondré en contacto contigo muy pronto.\n\n' +
        'Mientras tanto, puedes explorar las calculadoras hipotecarias y guías gratuitas en https://www.loantechies.com, ' +
        'o iniciar tu solicitud cuando quieras en https://www.loanfactory.com/anandvangari.\n\n' +
        'Saludos,\n\n' +
        signature('es') + '\n\n' +
        'Esta es una confirmación automática de que recibimos tu mensaje. Puedes responder a este correo para comunicarte directamente conmigo.',
    };
  }
  if (code === 'hi') {
    const greeting = who ? `Namaste ${who},` : 'Namaste,';
    return {
      subject: 'Loan Techies se sampark karne ke liye dhanyavaad',
      body: `${greeting}\n\n` +
        'Loan Techies ke through reach out karne ke liye dhanyavaad — maine aapki inquiry receive kar li hai aur jaldi hi aapse contact karunga.\n\n' +
        'Is beech, https://www.loantechies.com par free mortgage calculators aur guides explore karein, ' +
        'ya kabhi bhi https://www.loanfactory.com/anandvangari par apni application shuru karein.\n\n' +
        'Jaldi baat karte hain,\n\n' +
        signature('hi') + '\n\n' +
        'Yeh ek automated confirmation hai ki aapka message mil gaya. Mujhse seedhe baat karne ke liye aap is email ka reply kar sakte hain.',
    };
  }
  if (code === 'te') {
    const greeting = who ? `Namaste ${who},` : 'Namaste,';
    return {
      subject: 'Loan Techies ni sampradinchinanduku dhanyavaadalu',
      body: `${greeting}\n\n` +
        'Loan Techies dwaaraa sampradinchinanduku dhanyavaadalu — nenu mee inquiry andukunnaanu, mariyu twaralo mimmalni sampradistaanu.\n\n' +
        'Ee madhya, https://www.loantechies.com lo free mortgage calculators mariyu guides chudandi, ' +
        'leda eppudaina https://www.loanfactory.com/anandvangari lo mee application start cheyandi.\n\n' +
        'Twaralo maatladataam,\n\n' +
        signature('te') + '\n\n' +
        'Idi mee message andindi ani telipe automated confirmation. Naatho nerugaa maatladataaniki meeru ee email ki reply cheyavachu.',
    };
  }

  const greetEn = who ? `Hi ${who},` : 'Hi there,';
  return {
    subject: 'Thanks for reaching out to Loan Techies',
    body: `${greetEn}\n\n` +
      "Thanks for reaching out through Loan Techies — I've received your inquiry and will get back to you shortly.\n\n" +
      'In the meantime, feel free to explore the free mortgage calculators and guides at https://www.loantechies.com, ' +
      'or start your application any time at https://www.loanfactory.com/anandvangari.\n\n' +
      'Talk soon,\n\n' +
      signature('en') + '\n\n' +
      'This is an automated confirmation that your message was received. You can simply reply to this email to reach me directly.',
  };
}

// Current time in Pacific for the lead email's "Received" line.
function pacificNow() {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date()) + ' PT';
  } catch {
    return new Date().toUTCString();
  }
}
