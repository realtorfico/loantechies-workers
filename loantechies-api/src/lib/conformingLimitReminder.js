// Port of Config/ConformingLimitReminder.cs — yearly reminder, deliberately NOT an automated
// update. FHFA republishes the new year's limits once a year (typically late November), so this
// fires once a year, pulls the CURRENTLY DEPLOYED values straight from the live site (no separate
// copy to drift out of sync), and emails a reminder to check them against FHFA's new figures.
// Runs Dec 1, 9:00 AM UTC — a distinct cron slot from the other two.
//
// loantechies wwwroot/js/core.js has TWO separate conforming-limit tables:
// - CA_COUNTY_LIMIT: precise per-county limits, used for the JUMBO-LOAN WARNING on the main
//   estimate/rate page — the more consequential one, since a stale value here could tell a real
//   borrower their loan is conforming when FHFA would call it jumbo (or vice versa).
// - CONFORMING_BASE / CONFORMING_HICOST / CA_HICOST: a simpler 2-tier + county-list version used
//   only for the informational blurb under the county selector on other calculator pages.
// Both are reported here so a stale value in EITHER system gets caught.
import { businessInbox, sendViaResend } from './emailer.js';

const FRONTEND_CORE_JS_URL = 'https://www.loantechies.com/js/core.js';
const FHFA_LIMITS_URL = 'https://www.fhfa.gov/data/conforming-loan-limit';
const FHFA_MAP_URL = 'https://www.fhfa.gov/data/dashboard/conforming-loan-limit-values-map';

// Pulls CONFORMING_BASE / CONFORMING_HICOST / CA_HICOST / CA_COUNTY_LIMIT straight out of the
// live frontend JS text via regex — no separate stored copy to drift out of sync with what's
// actually deployed. Returns nulls/empty for anything it can't find rather than throwing. Public
// for testing.
export function parseCurrentLimits(coreJs) {
  const result = { base: null, highCost: null, highCostCountiesRaw: null, countyLimits: {} };
  if (!coreJs) return result;

  const baseMatch = /CONFORMING_BASE\s*=\s*(\d+)/.exec(coreJs);
  if (baseMatch) result.base = parseInt(baseMatch[1], 10);

  const hicostMatch = /CONFORMING_HICOST\s*=\s*(\d+)/.exec(coreJs);
  if (hicostMatch) result.highCost = parseInt(hicostMatch[1], 10);

  const countiesMatch = /CA_HICOST\s*=\s*\[([^\]]*)\]/.exec(coreJs);
  if (countiesMatch) result.highCostCountiesRaw = countiesMatch[1];

  const countyLimitMatch = /CA_COUNTY_LIMIT\s*=\s*\{([\s\S]*?)\}\s*;/.exec(coreJs);
  if (countyLimitMatch) {
    const inner = countyLimitMatch[1];
    const entryRe = /'([^']+)'\s*:\s*(\d+)/g;
    let m;
    while ((m = entryRe.exec(inner)) !== null) {
      result.countyLimits[m[1]] = parseInt(m[2], 10);
    }
  }

  return result;
}

function n0(v) {
  return v.toLocaleString('en-US');
}

// Public for testing.
export function buildReminderBody(current) {
  const lines = [
    'Yearly reminder: check the CA conforming and high-cost loan limits against FHFA\'s new figures.',
    '',
    `FHFA's official limits page: ${FHFA_LIMITS_URL}`,
    `FHFA's county map/lookup:     ${FHFA_MAP_URL}`,
    '',
    'This is a REMINDER only — nothing here is auto-compared or auto-changed. FHFA',
    'republishes these limits once a year (usually late November for the following',
    'year), so most of the year there will be nothing to update.',
    '',
    '=== CA_COUNTY_LIMIT (used for the JUMBO-LOAN WARNING on the main estimate/rate page — check this one first) ===',
  ];

  const countyLimits = current?.countyLimits || {};
  const countyKeys = Object.keys(countyLimits);
  if (countyKeys.length > 0) {
    for (const county of countyKeys.sort()) lines.push(`  ${county.padEnd(18)} = ${n0(countyLimits[county])}`);
  } else {
    lines.push('  (could not read live values this time — check the file directly)');
  }

  lines.push('');
  lines.push('=== CONFORMING_BASE / CONFORMING_HICOST (used only for the informational blurb');
  lines.push('    under the county selector on other calculator pages) ===');
  lines.push(current?.base != null
    ? `  CONFORMING_BASE   = ${n0(current.base)}  (every CA county not listed below)`
    : '  CONFORMING_BASE   = (could not read live value this time — check the file directly)');
  lines.push(current?.highCost != null
    ? `  CONFORMING_HICOST = ${n0(current.highCost)}  (high-cost counties only)`
    : '  CONFORMING_HICOST = (could not read live value this time — check the file directly)');
  if (current?.highCostCountiesRaw && current.highCostCountiesRaw.trim())
    lines.push(`  CA_HICOST counties = [${current.highCostCountiesRaw.trim()}]`);

  lines.push('');
  lines.push('If FHFA\'s new numbers differ, update CA_COUNTY_LIMIT (the one that actually drives');
  lines.push('the jumbo-loan warning) and, if you keep them in sync, CONFORMING_BASE /');
  lines.push('CONFORMING_HICOST / CA_HICOST too, in wwwroot/js/core.js, then run');
  lines.push('`node tools/seo-gen.js` to propagate the change to every prerendered page.');

  return lines.join('\n');
}

export async function run(env) {
  const to = businessInbox(env);
  if (!to) {
    console.error('ConformingLimitReminder: no business inbox configured (INQUIRY_TO_EMAIL/GMAIL_USER) — cannot send.');
    return;
  }

  let current = null;
  try {
    const res = await fetch(FRONTEND_CORE_JS_URL);
    if (res.ok) current = parseCurrentLimits(await res.text());
    else console.warn(`ConformingLimitReminder: core.js fetch returned HTTP ${res.status} — sending reminder without current values.`);
  } catch (e) {
    console.warn(`ConformingLimitReminder: could not fetch/parse live core.js — sending reminder without current values. ${e.message}`);
  }

  const body = buildReminderBody(current);
  await sendViaResend(env, to, '[LoanTechies] Yearly reminder — check CA conforming loan limits against FHFA', body);
  console.log(`ConformingLimitReminder: sent yearly reminder to ${to}.`);
}
