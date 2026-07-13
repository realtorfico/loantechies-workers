/**
 * PARKED — NOT WIRED INTO THE WORKER. Reference only.
 *
 * Written 2026-07-10 against a PDF export of a Rocket Pro rate email, believing "Today's Rates" was a
 * real HTML table. It is not — Rocket Pro's rate sheet is a JPG image
 * (`https://rate-sheets-files.qlms.foc.zone/Rate_Sheet_Image-Correspondent-<date>.jpg`) embedded via
 * `<img>`, with zero rate table markup anywhere in the email HTML (confirmed by reading the actual raw
 * .eml source that day). This code can never match anything and was replaced with Vision AI extraction
 * (see index.js) the same day.
 *
 * Kept here in case Rocket Pro ever switches its rate sheet from an image back to a real HTML table —
 * if `Today's Rates` (or similar) ever shows up as actual `<table>` markup in a future email, this is
 * a reasonable starting point to resurrect (re-wire into index.js's handleRocketPro in place of the
 * Vision AI call, or as a fallback tried first / after it).
 */

function parseRocketProEmail(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // "Friday, July 10, 2026" date banner above the rate table.
  const dateMatch = html.match(/[A-Za-z]+day,\s*[A-Za-z]+ \d{1,2},\s*\d{4}/);
  const emailDate = dateMatch ? dateMatch[0] : '';

  return {
    source: 'rocketpro',
    emailDate,
    conventional: extractRocketProRates(html),
    nonQm: [],
  };
}

function extractRocketProRates(html) {
  const idx = html.search(/Today['’]?s Rates/i);
  const tableStart = html.indexOf('<table', idx === -1 ? 0 : idx);
  if (tableStart === -1) return [];

  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableEnd === -1) return [];

  const rows = [];
  for (const trMatch of html.slice(tableStart, tableEnd + 8).matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...trMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => stripTags(m[1]).trim());

    if (cells.length < 2) continue;
    const rate = parsePercent(cells[1]);
    if (cells[0] && /year|yr/i.test(cells[0]) && !isNaN(rate)) {
      // No APR column in this email — the backend synthesizes APR = Rate for Rocket Pro rows
      // (a par/zero-point quote has no finance-charge spread to redistribute).
      rows.push({ loanType: cells[0], rate });
    }
  }
  return rows;
}

// parsePercent/stripTags are duplicated from index.js's shared helpers here since this file is
// deliberately standalone/unwired — if resurrected, delete these and reuse index.js's copies instead.

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
