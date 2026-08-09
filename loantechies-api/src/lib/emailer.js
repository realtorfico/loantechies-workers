// Port of Utils/Emailer.cs — Resend-only (per the migration plan: Workers have no clean Gmail-SMTP
// fallback equivalent, and Resend was already the preferred path in the C# — it tried Resend
// first and only fell back to Gmail SMTP when RESEND_API_KEY was unset). If RESEND_API_KEY is ever
// misconfigured on this Worker, sends fail loud (caught by the daily secret-presence health check
// planned for this Worker) rather than silently falling back.

// The monitored business inbox (BCC copies / alert routing). INQUIRY_TO_EMAIL when set, else the
// Gmail sender address (kept only as an address to route to, not as an SMTP credential).
export function businessInbox(env) {
  return env.INQUIRY_TO_EMAIL || env.GMAIL_USER || null;
}

// Returns true on success, false (logged) otherwise — never throws.
export async function sendViaResend(env, to, subject, body, bcc = null) {
  if (!to || !to.trim()) return false;
  if (bcc && bcc.trim().toLowerCase() === to.trim().toLowerCase()) bcc = null; // don't BCC the same address

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Emailer: RESEND_API_KEY is not configured.');
    return false;
  }

  const from = env.EMAIL_FROM || 'Loan Techies <noreply@loantechies.com>';
  const replyTo = env.EMAIL_REPLY_TO || env.GMAIL_USER;

  const payload = { from, to: [to], subject: subject || '', text: body || '' };
  if (replyTo && replyTo.trim()) payload.reply_to = replyTo;
  if (bcc && bcc.trim()) payload.bcc = [bcc];

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return true;
    const err = await res.text();
    console.error(`Emailer (Resend) to '${to}' failed: ${res.status} ${err}`);
    return false;
  } catch (e) {
    console.error(`Emailer (Resend) to '${to}' threw: ${e.message}`);
    return false;
  }
}

// Normalize a UI language string to a supported code: es / hi / te / en.
export function langCode(lang) {
  const l = (lang || '').trim().toLowerCase();
  if (l.startsWith('es')) return 'es';
  if (l.startsWith('hi')) return 'hi';
  if (l.startsWith('te')) return 'te';
  return 'en';
}

// Shared MLO signature block (Spanish job title for es; English for en/hi/te).
export function signature(code) {
  const role = code === 'es' ? 'Originador de Préstamos Hipotecarios' : 'Mortgage Loan Originator';
  return `Anand V.\n${role}\nNMLS #2471270 | CA-DRE #02208256\nLoan Factory - Tracy, CA\nhttps://www.loantechies.com`;
}
