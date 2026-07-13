/**
 * LoanTechies Rate Email Ingest — Cloudflare Email Worker
 *
 * Triggered when rates@loantechies.com receives a forwarded daily-rates email. Handles TWO distinct
 * senders that both land at this same address: LoanFactory's own daily rate email, and (added
 * 2026-07-10) Rocket Pro's correspondent rate sheet forwarded through the same LoanFactory inbox.
 * Both are content-gated by subject, parsed independently, and POSTed to the backend tagged with
 * their own `source` so they're stored (and compared) separately — see ExternalRates.cs /
 * LoanFactoryRatesProvider.cs for how the backend picks the lower of the two per loan product.
 *
 * Rocket Pro's rate sheet is a JPG IMAGE, not HTML (confirmed by reading the raw .eml source
 * 2026-07-10 — there is no table markup anywhere, an earlier HTML-table parser attempt never had a
 * chance of matching anything real; parked in rocketpro-html-parser.reference.js). Extraction is
 * Cloudflare Workers AI (a vision model reading the image), not string parsing — see handleRocketPro.
 *
 * Required secrets/bindings (Worker Settings → Variables & Secrets, and Settings → Bindings):
 *   BACKEND_INGEST_KEY  — secret, must match the LOANFACTORY_INGEST_KEY Azure Function env var.
 *   AI                  — Workers AI binding (Bindings tab, NOT Variables & Secrets — it's a resource
 *                          binding like KV/D1, not a secret string). Required for Rocket Pro only;
 *                          LoanFactory's HTML parsing doesn't need it.
 *
 * Deploy: Cloudflare Dashboard → Workers & Pages → Create Worker → paste this file.
 * Route:  Email Routing (for loantechies.com) → Routes → rates@loantechies.com → Send to Worker.
 */

const BACKEND_URL =
  'https://softician-api.azurewebsites.net/api/console/rates/loanfactory/ingest';

// LoanFactory sends TWO different daily rate emails that both pass any subject/sender check
// identically: the real personalized one (anand.vangari@loanfactory.com, scenario ZIP 95377 — the
// practice's actual numbers) and a generic example (info@loanfactory.com, a FIXED $300k/$400k/
// 759-credit/95111 sample scenario). Discovered 2026-07-06 when the wrong one got forwarded here
// and its numbers silently overwrote the real day's snapshot (upsert-by-date — whichever email's
// POST lands last for the day wins).
//
// Can't gate on message.from to tell them apart: Gmail rewrites `From:` to the user's OWN Gmail
// address on EVERY forward (automatic filter-forward included, not just a manual "Fwd:" click) —
// see the gmail-forward-from-address lesson. An earlier version of this fix tried a sender
// allowlist and would have silently broken ingestion entirely once the Gmail filter forwarded the
// real email automatically. Gate on the PARSED SCENARIO CONTENT instead — the real ZIP (95377) is
// something Gmail can't rewrite.
const REQUIRED_ZIP = '95377';

export default {
  async email(message, env) {
    const subject = (message.headers?.get('subject') ?? '').toLowerCase();

    if (subject.includes('rates update')) {
      await handleLoanFactory(message, env, subject);
    } else if (subject.includes('rocket pro') && subject.includes('rates')) {
      await handleRocketPro(message, env, subject);
    } else {
      console.log(`Email Worker: ignored (from=${message.from}, subject=${subject})`);
    }
  },
};

// ── LoanFactory ─────────────────────────────────────────────────────────────

async function handleLoanFactory(message, env, subject) {
  const raw = await new Response(message.raw).text();
  const isQP = /content-transfer-encoding:\s*quoted-printable/i.test(raw);
  const html = extractHtmlPart(raw, isQP);

  if (!html) {
    console.error('Email Worker: could not extract HTML from LoanFactory email');
    return;
  }

  const data = parseLoanFactoryEmail(html);

  if (!data.scenario.includes(REQUIRED_ZIP)) {
    console.log(`Email Worker: ignored — scenario doesn't match the real practice (scenario="${data.scenario}")`);
    return;
  }

  console.log(
    `Email Worker: parsed ${data.conventional.length} conventional, ` +
    `${data.nonQm.length} non-QM LoanFactory rates for ${data.emailDate}`
  );

  await postToBackend(data, env, 'LoanFactory');
}

function parseLoanFactoryEmail(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '');  // strip HTML comments

  // "Purchase, 30-yr fixed, $375K Loan, $500K Value, Credit 740"
  const scenMatch = html.match(/Purchase[^<\r\n]{5,150}/i);
  const scenario = scenMatch ? stripTags(scenMatch[0]).trim() : '';

  // "Rates update Jun 30, 2026, 10:02 AM"
  const dateMatch = html.match(/Rates update\s+([A-Za-z]+ \d{1,2},\s*\d{4}[^<\r\n]*)/i);
  const emailDate = dateMatch ? stripTags(dateMatch[1]).trim() : '';

  return {
    source: 'loanfactory',
    scenario,
    emailDate,
    conventional: extractSection(html, 'Conventional'),
    nonQm: extractSection(html, 'Non-QM'),
  };
}

function extractSection(html, keyword) {
  const idx = html.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return [];

  const tableStart = html.indexOf('<table', idx);
  if (tableStart === -1) return [];

  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableEnd === -1) return [];

  return parseTableRows(html.slice(tableStart, tableEnd + 8));
}

function parseTableRows(tableHtml) {
  const rows = [];
  let headerSkipped = false;

  for (const trMatch of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...trMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => stripTags(m[1]).trim());

    if (cells.length < 3) continue;
    if (!headerSkipped) { headerSkipped = true; continue; }

    const rate = parsePercent(cells[1]);
    const apr  = parsePercent(cells[2]);
    if (cells[0] && !isNaN(rate)) {
      rows.push({ loanType: cells[0], rate, apr: isNaN(apr) ? rate : apr });
    }
  }
  return rows;
}

// ── Rocket Pro ──────────────────────────────────────────────────────────────
//
// Rocket Pro's daily correspondent rate sheet is forwarded through the same LoanFactory inbox and
// lands at rates@loantechies.com alongside LoanFactory's own email. The rate table is a JPG image
// (`https://rate-sheets-files.qlms.foc.zone/Rate_Sheet_Image-Correspondent-<date>.jpg`), not HTML —
// extraction runs the image through a Cloudflare Workers AI vision model. Only the products
// LoanTechies actually prices matter downstream (30/15 Year Agency, FHA/VA Full Doc — see
// LoanFactoryRatesProvider.RocketProLabelMap / RocketProDirect15yrLabelMap); 5 Year ARM is captured
// too (admin-diagnostic visibility only, not priced — ARM was dropped from the estimate page
// 2026-07-02). DSCR/Jumbo Smart/VA IRRRL are on the rate sheet but not requested from the model at
// all — no use for them today.
//
// Verified working end-to-end live 2026-07-10 (image fetch -> Vision AI -> parse -> ingest all
// succeeded). Two known characteristics, not bugs: (1) the model doesn't reliably return all 5
// products every run — e.g. FHA present one delivery, absent the next on what looked like the same
// image — handled by design, every product is optional and merged opportunistically on the backend;
// (2) requires the Workers AI Llama 3.2 Vision one-time license acceptance per Cloudflare account
// (error code 5016 until done — see loantechies-rocketpro-rate-source memory for the fix). Financial-
// data caution: the backend independently plausibility-checks every extracted rate against
// LoanFactory's same-day rate before it can win a pricing cell (see
// LoanFactoryRatesProvider.FilterImplausibleRocketProCells) — this Worker's own range check below is
// just a cheap first filter, not the real safety net.

const RATE_SHEET_PRODUCTS = ['30 Year Agency', '15 Year Agency', '5 Year ARM', '30 Year FHA Full Doc', '30 Year VA Full Doc'];
const PLAUSIBLE_RATE_MIN = 2.0;
const PLAUSIBLE_RATE_MAX = 12.0;

async function handleRocketPro(message, env, subject) {
  const raw = await new Response(message.raw).text();
  const isQP = /content-transfer-encoding:\s*quoted-printable/i.test(raw);
  const html = extractHtmlPart(raw, isQP);

  if (!html) {
    console.error('Email Worker: could not extract HTML from Rocket Pro email');
    return;
  }

  const imageUrl = extractRateSheetImageUrl(html);
  if (!imageUrl) {
    console.error('Email Worker: could not find the Rocket Pro rate-sheet image URL in the email');
    return;
  }

  // The "Friday, July 10, 2026" date banner turned out to be baked into the rate-sheet IMAGE, not
  // real HTML text (same mistake class as the original table-parsing attempt) — so it's asked for in
  // the same Vision AI call instead. The real SMTP Date header is a trustworthy (if less precise)
  // fallback/sanity-check for it: a hallucinated date is lower-stakes than a hallucinated rate, but
  // still shouldn't be trusted blind — see validateExtractedDate.
  const headerDate = message.headers?.get('date') || '';

  let extracted;
  try {
    extracted = await extractRatesFromImage(imageUrl, env);
  } catch (err) {
    console.error(`Email Worker: Rocket Pro Vision AI extraction failed — ${err.message}`);
    return;
  }

  const { rows, date: modelDate } = extracted;
  const emailDate = validateExtractedDate(modelDate, headerDate);

  if (!rows.length) {
    console.log('Email Worker: ignored Rocket Pro email — Vision AI returned no plausible rates');
    return;
  }
  if (!rows.some(r => r.loanType === '30 Year Agency')) {
    console.log(`Email Worker: ignored Rocket Pro email — '30 Year Agency' missing or implausible (got: ${rows.map(r => r.loanType).join(', ')})`);
    return;
  }

  console.log(`Email Worker: Vision AI extracted ${rows.length} Rocket Pro rates for ${emailDate} (model said "${modelDate}"): ${JSON.stringify(rows)}`);

  await postToBackend({ source: 'rocketpro', emailDate, conventional: rows, nonQm: [] }, env, 'Rocket Pro');
}

// Accepts the model's reading of the on-image date banner only if it parses to a real date within
// ±3 days of the email's actual SMTP Date header (catches a hallucinated/misread date without
// requiring exact agreement — the banner and SMTP timestamp can legitimately differ by hours).
// Falls back to the header date (real, just possibly less precise) if the model's reading fails that
// check, and to '' (ingest endpoint's own Pacific-"today" fallback) if even the header is unusable.
function validateExtractedDate(modelDate, headerDate) {
  const headerParsed = headerDate ? new Date(headerDate) : null;
  const headerValid = headerParsed && !isNaN(headerParsed.getTime());

  if (modelDate) {
    const modelParsed = new Date(modelDate);
    if (!isNaN(modelParsed.getTime())) {
      const withinRange = !headerValid || Math.abs(modelParsed.getTime() - headerParsed.getTime()) <= 3 * 24 * 60 * 60 * 1000;
      if (withinRange) return modelDate;
      console.log(`Email Worker: Rocket Pro model-read date "${modelDate}" is >3 days from the email header date "${headerDate}" — discarding, using header date instead`);
    }
  }

  return headerValid ? headerDate : '';
}

function extractRateSheetImageUrl(html) {
  const usemapMatch = html.match(/<img[^>]+usemap="#rateSheet"[^>]+src="([^"]+)"/i);
  if (usemapMatch) return usemapMatch[1];

  // Fallback if the usemap attribute ever disappears — any image src that looks like a rate sheet.
  const fallbackMatch = html.match(/<img[^>]+src="(https:\/\/[^"]*rate[-_]?sheet[^"]*\.(?:jpg|jpeg|png))"/i);
  return fallbackMatch ? fallbackMatch[1] : null;
}

async function extractRatesFromImage(imageUrl, env) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`image fetch failed ${imgRes.status}`);
  const buf = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

  const result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    messages: [
      { role: 'system', content: 'You extract mortgage rate tables from rate-sheet images. Respond with ONLY valid JSON, no prose, no markdown code fences.' },
      { role: 'user', content: `Read the rate table in this image. Extract the "Rate" column value (a percentage) for each of these exact product rows if visible: ${RATE_SHEET_PRODUCTS.map(p => `"${p}"`).join(', ')}. Also find the date shown at the top of the sheet (e.g. a banner like "Friday, July 10, 2026") and include it as "date". Return a JSON object mapping each product name found to its rate as a plain number (e.g. 6.25, not "6.25%"), plus the "date" field. Omit a rate key entirely if that row isn't visible or you're not confident in the reading; omit "date" if it isn't visible either. Example: {"30 Year Agency": 6.25, "30 Year FHA Full Doc": 5.75, "date": "Friday, July 10, 2026"}` },
    ],
    image: `data:${contentType};base64,${base64}`,
  });

  // Response shape confirmed live 2026-07-10: for this messages+image combo, .response comes back as
  // an ALREADY-PARSED object (e.g. {"30 Year Agency":6.25,...}), not a JSON string — despite the
  // system prompt asking for "ONLY valid JSON" as text. Kept the string-shape fallbacks
  // (extractResponseText) in case that ever changes for a different model/input combo. Still logging
  // the raw shape every time — cheap, and the next surprise deserves the same fast diagnosis this one got.
  console.log(`Email Worker: Rocket Pro raw AI result: ${JSON.stringify(result).slice(0, 1000)}`);

  let parsed;
  if (result?.response && typeof result.response === 'object' && !Array.isArray(result.response)) {
    parsed = result.response;
  } else {
    const text = extractResponseText(result).trim();
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { parsed = JSON.parse(jsonText); } catch { throw new Error(`could not parse model response as JSON: ${text.slice(0, 200)}`); }
  }

  const rows = [];
  for (const product of RATE_SHEET_PRODUCTS) {
    const rate = Number(parsed[product]);
    if (Number.isFinite(rate) && rate >= PLAUSIBLE_RATE_MIN && rate <= PLAUSIBLE_RATE_MAX) {
      rows.push({ loanType: product, rate });
    } else if (product in parsed) {
      console.log(`Email Worker: Rocket Pro '${product}' reading (${parsed[product]}) outside plausible range ${PLAUSIBLE_RATE_MIN}-${PLAUSIBLE_RATE_MAX}% — dropped`);
    }
  }
  return { rows, date: typeof parsed.date === 'string' ? parsed.date : '' };
}

// Workers AI response shape varies by model/input combo — a plain {prompt:...} text call returns a
// flat string at .response, but chat-style {messages:...} calls on some models return an
// OpenAI-style {choices:[{message:{content}}]} shape instead, or nest an object under .response. Try
// the known shapes in order; never throw here — an unrecognized shape falls through to JSON.parse
// failing cleanly downstream (with the raw result already logged by the caller) rather than crashing.
function extractResponseText(result) {
  if (typeof result?.response === 'string') return result.response;
  if (typeof result === 'string') return result;
  const choiceContent = result?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return choiceContent;
  if (typeof result?.response?.content === 'string') return result.response.content;
  return '';
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── Shared ────────────────────────────────────────────────────────────────────

async function postToBackend(data, env, label) {
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Key': env.BACKEND_INGEST_KEY,
    },
    body: JSON.stringify(data),
  });

  if (res.ok) {
    const json = await res.json();
    console.log(`Email Worker: ingested ${label} successfully (date=${json.date})`);
  } else {
    const text = await res.text();
    console.error(`Email Worker: ${label} ingest failed ${res.status} — ${text}`);
    throw new Error(`Backend returned ${res.status}`);
  }
}

// ── MIME ──────────────────────────────────────────────────────────────────────

function extractHtmlPart(raw, isQP) {
  const htmlTypeIdx = raw.search(/content-type:\s*text\/html/i);

  if (htmlTypeIdx === -1) {
    // Not multipart — check if whole body is already HTML
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart === -1) return null;
    const body = raw.slice(bodyStart + 4);
    return body.includes('<table') || body.includes('<html')
      ? decode(body, isQP)
      : null;
  }

  // Jump past the content-type section headers to the blank line that opens the body
  const headerEnd = raw.indexOf('\r\n\r\n', htmlTypeIdx);
  if (headerEnd === -1) return null;

  let html = raw.slice(headerEnd + 4);

  // Trim at the next MIME boundary (lines starting with --)
  const boundaryIdx = html.indexOf('\r\n--');
  if (boundaryIdx !== -1) html = html.slice(0, boundaryIdx);

  return decode(html.trim(), isQP);
}

function decode(text, isQP) {
  if (!isQP) return text;
  return text
    .replace(/=\r\n/g, '')   // soft line break
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ── Shared parsing helpers ────────────────────────────────────────────────────

function parsePercent(s) {
  return parseFloat((s || '').replace('%', '').trim());
}

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&#39;/g,  "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g,    ' ')
    .trim();
}
