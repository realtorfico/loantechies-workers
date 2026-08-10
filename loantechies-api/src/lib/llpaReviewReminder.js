// Port of Config/LlpaReviewReminder.cs — monthly reminder, deliberately NOT an automated diff.
// Decided 2026-07-02 in the original: fetching/parsing Fannie Mae's published LLPA matrix was
// rejected as fragile (direct fetch 403s, no reliably machine-parseable mirror) for something
// Fannie only republishes a few times a year. Instead this emails the business inbox the current
// stored LLPA/GovAdj tables side-by-side with a link to Fannie's page, prompting a quick manual
// comparison. Runs 1st of every month, 9:00 AM UTC — a distinct cron slot from the other two
// (*/5 * * * * and 0 15 * * *).
import { businessInbox, sendViaResend } from './emailer.js';
import { CREDIT_TIERS, LTV_COLUMN_LABELS } from './rateConfig.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';

const FANNIE_LLPA_URL = 'https://singlefamily.fanniemae.com/originating-underwriting/mortgage-products/eligibility-pricing';
const ADMIN_RATE_SETTINGS_URL = 'https://admin.loantechies.com/#/rate-config';

function pad(s, len, left = false) {
  s = String(s);
  return left ? s.padStart(len) : s.padEnd(len);
}

function appendMatrix(lines, title, matrix) {
  lines.push(title + ':');
  lines.push('Credit tier    | ' + LTV_COLUMN_LABELS.map((c) => pad(c, 6, true)).join(' | '));
  for (const tier of CREDIT_TIERS) {
    const row = (matrix && matrix[tier]) || new Array(LTV_COLUMN_LABELS.length).fill(0);
    lines.push(pad(tier, 14) + ' | ' + row.map((v) => pad(v.toFixed(3), 6, true)).join(' | '));
  }
}

// Public for testing.
export function buildReminderBody(cfg) {
  const lines = [
    'Monthly reminder: compare the stored LLPA / Government adjustment tables below against Fannie Mae\'s currently published matrix.',
    '',
    `Fannie Mae's official matrix: ${FANNIE_LLPA_URL}`,
    `Your Rate Settings page:      ${ADMIN_RATE_SETTINGS_URL}`,
    '',
    'This is a REMINDER only — nothing here is auto-compared or auto-changed. Fannie republishes',
    'this matrix only a few times a year, so most months there will be nothing to update.',
    '',
  ];
  appendMatrix(lines, 'LLPA (Conventional)', cfg?.llpa);
  lines.push('');
  appendMatrix(lines, 'Government adjustments (FHA/VA/USDA)', cfg?.govAdj);
  return lines.join('\n');
}

export async function run(env) {
  const cfg = await loadRateConfig(env);
  if (!cfg) {
    console.warn('LlpaReviewReminder: estimated-rate config unavailable — skipping this month\'s reminder.');
    return;
  }

  const to = businessInbox(env);
  if (!to) {
    console.error('LlpaReviewReminder: no business inbox configured (INQUIRY_TO_EMAIL/GMAIL_USER) — cannot send.');
    return;
  }

  const body = buildReminderBody(cfg);
  await sendViaResend(env, to, '[LoanTechies] Monthly reminder — verify LLPA table against Fannie Mae', body);
  console.log(`LlpaReviewReminder: sent monthly reminder to ${to}.`);
}
