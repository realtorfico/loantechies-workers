// Port of Loans/LoanFactoryRatesProvider.cs — the rate source for the estimate flow, lead-rate
// emails, and Rate Watch. Merges LoanFactory's daily email snapshot with Rocket Pro's (image-
// extracted) and Provident's (wholesale-derived) rates, taking the lower note rate per
// (loanType, occupancy) cell, then derives Refi/15yr products off the Conventional-Primary root
// via RateConfig's admin-configurable deltas. Real LoanFactory-quoted rows always take precedence
// via LabelMap; anything not directly quoted falls through to the formula chain.
//
// Branch maps use string keys `${loanType}::${occupancy}` (JS has no tuple-key objects/Maps the
// way C# does with value-tuples) — see the key()/unkey() helpers below.
import { solveFinanceChargeFraction, solveApr } from './regZApr.js';
import { fallbackFor } from './rateConfig.js';
import { pacificDateOf, daysBetween, expectedSnapshotReferenceDate, lastExpectedBusinessDay } from './pacificDate.js';
import { getRecentSnapshots } from './externalRates.js';
import { loadAsync as loadProvident } from './providentRatesProvider.js';
import { shouldAlert } from './alertCooldown.js';
import { businessInbox, sendViaResend } from './emailer.js';

// Fixed lookup: LoanFactory's raw loanType label -> (loanType, occupancy). Verified live
// 2026-07-02; owner confirmed these exact strings are stable.
export const LABEL_MAP = {
  'conventional - primary': { loanType: 'Conventional', occupancy: 'Primary Residence' },
  'conventional - investment': { loanType: 'Conventional', occupancy: 'Investment Property' },
  'conventional - second home': { loanType: 'Conventional', occupancy: 'Second Home' },
  'fha - primary': { loanType: 'FHA', occupancy: 'Primary Residence' },
  'va (veteran loan) - primary': { loanType: 'VA', occupancy: 'Primary Residence' },
};

// Rocket Pro's raw loanType label -> (loanType, occupancy). Only the 3 Purchase/30yr/Primary
// products that overlap LABEL_MAP's direct-quote cells — ARM/Non-QM/etc. are deliberately unmapped.
export const ROCKET_PRO_LABEL_MAP = {
  '30 year agency': { loanType: 'Conventional', occupancy: 'Primary Residence' },
  '30 year fha full doc': { loanType: 'FHA', occupancy: 'Primary Residence' },
  '30 year va full doc': { loanType: 'VA', occupancy: 'Primary Residence' },
};

// Rocket Pro's one direct 15yr quote — LoanFactory never quotes 15yr directly (always
// formula-derived), so this is compared against the formula result separately in getQuote.
export const ROCKET_PRO_DIRECT_15YR_LABEL_MAP = {
  '15 year agency': { loanType: 'Conventional', occupancy: 'Primary Residence' },
};

const PRIMARY_LABEL = 'conventional - primary';
const MAX_FAILOVER_DAYS = 7;
const ALERT_COOLDOWN_MINUTES = 24 * 60;
const PLAUSIBILITY_THRESHOLD_POINTS = 1.0;

function key(loanType, occupancy) {
  return `${loanType}::${occupancy}`;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ---- Pure Conventional formula chain (public — unit-testable with a synthetic branches map) ----

export function computeConventionalFormula(branches, occupancy, term, refinance, cfg, snapshotDate) {
  const primary = branches[key('Conventional', 'Primary Residence')];
  if (!primary) return null; // root branch missing

  const feeFraction = solveFinanceChargeFraction(primary.rate, primary.apr, 360);
  const refi30Rate = primary.rate + (cfg.deltaRefi30AddOn ?? 0.2);
  const refi30Apr = solveApr(refi30Rate, 360, feeFraction);

  if (occupancy === 'Primary Residence') {
    if (term === 30 && refinance)
      return { available: true, rate: round4(refi30Rate), apr: refi30Apr, source: 'loanfactory-formula', snapshotDate };

    if (term === 15 && !refinance) {
      const rate = primary.rate + (cfg.deltaPurchase15AddOn ?? -0.5);
      const apr = solveApr(rate, 180, feeFraction);
      return { available: true, rate: round4(rate), apr, source: 'loanfactory-formula', snapshotDate };
    }

    if (term === 15 && refinance) {
      const rate = refi30Rate + (cfg.deltaRefi15AddOn ?? -0.5);
      const apr = solveApr(rate, 180, feeFraction);
      return { available: true, rate: round4(rate), apr, source: 'loanfactory-formula', snapshotDate };
    }

    return null; // ARM or other unsupported combo
  }

  if (occupancy === 'Investment Property' || occupancy === 'Second Home') {
    // Refinance-30F derives off PRIMARY's Refi-30F (shared delta, shared root) — NOT off this
    // occupancy's own Purchase row. Purchase-30F must come from its own direct branch (checked
    // earlier in getQuote) — there is no formula for it.
    if (term === 30 && refinance) {
      const rate = refi30Rate + (cfg.deltaInvSecondHomeRefi30AddOn ?? 0.25);
      const apr = solveApr(rate, 360, feeFraction);
      return { available: true, rate: round4(rate), apr, source: 'loanfactory-formula', snapshotDate };
    }
    return null; // 15yr/ARM unsupported for Investment/Second Home
  }

  return null;
}

function fallback(cfg, term, snapshotDate) {
  return { available: false, rate: round4(fallbackFor(cfg, term)), apr: null, source: 'config-fallback', snapshotDate };
}

// ---- Rocket Pro plausibility filter + merge (public — pure, unit-testable) ----

export function filterImplausibleRocketProCells(loanFactory, rocketPro) {
  const rejected = [];
  if (!rocketPro) return { filtered: null, rejected };

  const filtered = {};
  for (const [k, v] of Object.entries(rocketPro)) {
    const lf = loanFactory?.[k];
    if (lf && Math.abs(v.rate - lf.rate) > PLAUSIBILITY_THRESHOLD_POINTS) {
      rejected.push(k);
      continue;
    }
    filtered[k] = v;
  }
  return { filtered: Object.keys(filtered).length > 0 ? filtered : null, rejected };
}

// Per-cell, takes whichever source has the lower rate. A cell present in only one source uses
// that source's value unchanged. Ties keep LoanFactory.
export function mergeBranches(loanFactory, rocketPro) {
  const branches = loanFactory ? { ...loanFactory } : {};
  const branchSource = {};
  for (const k of Object.keys(branches)) branchSource[k] = 'loanfactory';

  if (rocketPro) {
    for (const [k, v] of Object.entries(rocketPro)) {
      if (!(k in branches) || v.rate < branches[k].rate) {
        branches[k] = v;
        branchSource[k] = 'rocketpro';
      }
    }
  }

  return { branches: Object.keys(branches).length > 0 ? branches : null, branchSource };
}

// Merges `incoming` into `branches` in place: a cell is taken only when it's lower than the
// existing (or absent), tagged `source`. Used for the Provident third source.
export function mergeSourceLower(branches, branchSource, incoming, source) {
  if (!incoming || !branches) return;
  for (const [k, v] of Object.entries(incoming)) {
    const ex = branches[k];
    if (!ex || v.rate < ex.rate) {
      branches[k] = v;
      branchSource[k] = source;
    }
  }
}

// ---- Label mapping ----

function mapLoanFactoryLabels(latest, env) {
  const branches = {};
  const recognized = new Set();

  for (const row of latest.conventional || []) {
    if (!row?.loanType) continue;
    const label = row.loanType.trim();
    const mapped = LABEL_MAP[label.toLowerCase()];
    if (mapped) {
      branches[key(mapped.loanType, mapped.occupancy)] = { rate: row.rate, apr: row.apr };
      recognized.add(label.toLowerCase());
    } else {
      console.warn(`LoanFactoryRatesProvider: unrecognized loanType label '${label}' on ${latest.date}`);
      alertUnrecognizedLabel(label, latest.date, env); // fire-and-forget
    }
  }

  if (!recognized.has(PRIMARY_LABEL)) {
    console.error(`LoanFactoryRatesProvider: 'Conventional - Primary' missing from ${latest.date} snapshot`);
    alertCriticalMissingPrimary(latest.date, env); // fire-and-forget
  }

  return branches;
}

function mapRocketProLabels(latest, labelMap) {
  const branches = {};
  for (const row of latest.conventional || []) {
    if (!row?.loanType) continue;
    const mapped = labelMap[row.loanType.trim().toLowerCase()];
    if (!mapped) continue;
    const apr = solveApr(row.rate, 360, 0.0) ?? row.rate;
    branches[key(mapped.loanType, mapped.occupancy)] = { rate: row.rate, apr };
  }
  return Object.keys(branches).length > 0 ? branches : null;
}

// ---- Snapshot loading (no in-memory cache — D1 reads are cheap; the C#'s 10-min cache existed
// to keep Azure Table Storage off the hot path, a latency concern D1 doesn't have to the same
// degree. If this ever needs revisiting, a per-isolate cache would go here.) ----

async function loadBranches(cfg, env) {
  const recent = await getRecentSnapshots(env, 1, 'loanfactory');
  let lfBranches = null;
  let snapshotDate = null;
  let isCurrent = false;

  if (recent.length > 0) {
    const latest = recent[0];
    snapshotDate = latest.date;
    const ageDays = daysBetween(pacificDateOf(new Date()), latest.date);
    isCurrent = latest.date === lastExpectedBusinessDay(expectedSnapshotReferenceDate(new Date()));
    if (ageDays <= MAX_FAILOVER_DAYS) lfBranches = mapLoanFactoryLabels(latest, env);
  }

  const rpRecent = await getRecentSnapshots(env, 1, 'rocketpro');
  let rpBranches = null;
  let direct15yrBranches = null;
  let rpSnapshotDate = null;
  if (rpRecent.length > 0) {
    const rpLatest = rpRecent[0];
    const rpAgeDays = daysBetween(pacificDateOf(new Date()), rpLatest.date);
    if (rpAgeDays <= MAX_FAILOVER_DAYS) {
      rpBranches = mapRocketProLabels(rpLatest, ROCKET_PRO_LABEL_MAP);
      direct15yrBranches = mapRocketProLabels(rpLatest, ROCKET_PRO_DIRECT_15YR_LABEL_MAP);
      rpSnapshotDate = rpLatest.date;
    }
  }

  const { filtered: rpFiltered, rejected: rpRejected } = filterImplausibleRocketProCells(lfBranches, rpBranches);
  for (const k of rpRejected) {
    const [rejType, rejOcc] = k.split('::');
    const product = Object.entries(ROCKET_PRO_LABEL_MAP).find(([, v]) => v.loanType === rejType && v.occupancy === rejOcc)?.[0] || k;
    alertRocketProImplausible(product, rpBranches[k].rate, lfBranches[k].rate, snapshotDate, env);
  }

  let { branches, branchSource } = mergeBranches(lfBranches, rpFiltered);

  // Provident (wholesale-derived) — best-effort like Rocket Pro.
  const { branch30: pvBranch30, direct15yr: pvDirect15, snapshotDate: pvSnapshotDate } = await loadProvident(cfg, env);
  const { filtered: pvFiltered, rejected: pvRejected } = filterImplausibleRocketProCells(lfBranches, pvBranch30);
  for (const k of pvRejected) alertProvidentImplausible(k, pvBranch30[k].rate, lfBranches[k].rate, snapshotDate, env);
  if (pvFiltered) {
    branches = branches || {};
    mergeSourceLower(branches, branchSource, pvFiltered, 'provident');
    if (Object.keys(branches).length === 0) branches = null;
  }

  const direct15yrSource = {};
  if (direct15yrBranches) for (const k of Object.keys(direct15yrBranches)) direct15yrSource[k] = 'rocketpro';
  let direct15 = direct15yrBranches;
  if (pvDirect15) {
    direct15 = direct15 || {};
    mergeSourceLower(direct15, direct15yrSource, pvDirect15, 'provident');
  }

  const sourceDates = {};
  if (snapshotDate) sourceDates.loanfactory = snapshotDate;
  if (rpSnapshotDate) sourceDates.rocketpro = rpSnapshotDate;
  if (pvSnapshotDate) sourceDates.provident = pvSnapshotDate;

  return { branches, branchSource, direct15yrBranches: direct15, direct15yrSource, snapshotDate, sourceDates, isCurrent };
}

// ---- Primary entry point ----

// Price one (loanType, occupancy, term, refinance) scenario.
export async function getQuote(loanType, occupancy, term, refinance, cfg, env) {
  const { branches, branchSource, direct15yrBranches, direct15yrSource, snapshotDate, sourceDates, isCurrent } = await loadBranches(cfg, env);
  const dateFor = (src) => sourceDates?.[src] || null;

  if (branches && !isCurrent) alertStale(snapshotDate, env);
  if (!branches) return fallback(cfg, term, snapshotDate);

  // 1. Direct-quote precedence — today's data only ever contains Purchase-30yr branches.
  if (!refinance && term === 30 && branches[key(loanType, occupancy)]) {
    const direct = branches[key(loanType, occupancy)];
    const src = branchSource[key(loanType, occupancy)] || 'loanfactory';
    return { available: true, rate: round4(direct.rate), apr: round4(direct.apr), source: `${src}-direct`, snapshotDate, sourceSnapshotDate: dateFor(src) };
  }

  // 2. Formula chain — Conventional only.
  if (loanType === 'Conventional') {
    const derived = computeConventionalFormula(branches, occupancy, term, refinance, cfg, snapshotDate);
    if (derived) {
      const rootSrc = branchSource[key('Conventional', 'Primary Residence')] || 'loanfactory';
      derived.sourceSnapshotDate = dateFor(rootSrc);

      // 2b. Rocket Pro/Provident quote 15yr directly — if present, plausible, and cheaper, it wins.
      if (!refinance && term === 15 && occupancy === 'Primary Residence' && direct15yrBranches?.[key(loanType, occupancy)]) {
        const directFifteen = direct15yrBranches[key(loanType, occupancy)];
        const plausible = Math.abs(directFifteen.rate - derived.rate) <= PLAUSIBILITY_THRESHOLD_POINTS;
        if (!plausible) {
          alertRocketProImplausible('15 Year Agency', directFifteen.rate, derived.rate, snapshotDate, env);
        } else if (directFifteen.rate < derived.rate) {
          const s15 = direct15yrSource?.[key(loanType, occupancy)] || 'rocketpro';
          return { available: true, rate: round4(directFifteen.rate), apr: round4(directFifteen.apr), source: `${s15}-direct-15yr`, snapshotDate, sourceSnapshotDate: dateFor(s15) };
        }
      }
      return derived;
    }
  }

  // 3. Combo genuinely unsupported today -> static fallback (defensive floor; normal callers are
  // already blocked by RateConfig.evaluateEligibility before reaching here).
  return fallback(cfg, term, snapshotDate);
}

// ---- Alerting (each kind rate-limited independently to ~once/day while it persists) ----

async function sendAlert(subject, details, env) {
  const to = businessInbox(env);
  if (!to) { console.error('Cannot send LoanFactory rate alert — no business inbox configured.'); return; }
  const body = `[LoanTechies LoanFactory Rate Alert]\n\n${details}\n\nSent at: ${new Date().toISOString()}\nThis alert repeats at most once per day while the issue persists.`;
  await sendViaResend(env, to, `[LoanTechies Alert] ${subject}`, body);
}

async function alertStale(snapshotDate, env) {
  if (!(await shouldAlert(env, 'loanfactory-stale', ALERT_COOLDOWN_MINUTES))) return;
  const expected = lastExpectedBusinessDay(expectedSnapshotReferenceDate(new Date()));
  await sendAlert(
    'LoanFactory rate data is not current',
    `The most recent LoanFactory snapshot is dated ${snapshotDate || '(unknown)'}, but the most recent expected business day is ${expected} ` +
    '(LoanFactory only emails Mon-Fri, excluding major US holidays). ' +
    'Estimate rates are still being served from this data (real, just not fresh) — this alert repeats daily until a current snapshot arrives. ' +
    `After ${MAX_FAILOVER_DAYS} consecutive days without a current snapshot, pricing falls back to the static config rates.`,
    env
  );
}

async function alertCriticalMissingPrimary(snapshotDate, env) {
  if (!(await shouldAlert(env, 'loanfactory-critical-missing-primary', ALERT_COOLDOWN_MINUTES))) return;
  await sendAlert(
    "URGENT: LoanFactory 'Conventional - Primary' missing",
    `The ${snapshotDate || '(unknown)'} LoanFactory snapshot is missing the 'Conventional - Primary' row. ` +
    'This is the root of the whole Conventional formula tree — Primary/Investment/Second-Home Refinance and ' +
    'Primary 15yr Fixed (Purchase + Refinance) are ALL now falling back to static config rates. ' +
    'Check the LoanFactory email ingest pipeline.',
    env
  );
}

async function alertUnrecognizedLabel(label, snapshotDate, env) {
  if (!(await shouldAlert(env, `loanfactory-unrecognized-${label}`, ALERT_COOLDOWN_MINUTES))) return;
  await sendAlert(
    'LoanFactory sent an unrecognized rate label',
    `The ${snapshotDate || '(unknown)'} LoanFactory snapshot includes a loanType label not in the known lookup: '${label}'. ` +
    "It's being skipped (not priced). If this is a new product LoanFactory started quoting, add it to LABEL_MAP.",
    env
  );
}

async function alertRocketProImplausible(product, rocketProRate, comparisonRate, snapshotDate, env) {
  if (!(await shouldAlert(env, `rocketpro-implausible-${product}`, ALERT_COOLDOWN_MINUTES))) return;
  await sendAlert(
    'Rocket Pro rate reading looks implausible',
    `Rocket Pro's '${product}' rate (${rocketProRate.toFixed(3)}%) differs from LoanFactory's same-day rate (${comparisonRate.toFixed(3)}%) by more than ` +
    `${PLAUSIBILITY_THRESHOLD_POINTS.toFixed(1)} percentage point(s) on ${snapshotDate || '(unknown)'}. Excluded from pricing — LoanFactory's rate is ` +
    'being used instead for this product today. Likely a Vision AI misread of the Rocket Pro rate-sheet image (not necessarily an error — ' +
    'check the Worker logs and the actual rate-sheet image for that date before assuming so).',
    env
  );
}

async function alertProvidentImplausible(product, providentRate, comparisonRate, snapshotDate, env) {
  if (!(await shouldAlert(env, `provident-implausible-${product}`, ALERT_COOLDOWN_MINUTES))) return;
  await sendAlert(
    'Provident rate reading looks implausible',
    `Provident's derived '${product}' rate (${providentRate.toFixed(3)}%) differs from LoanFactory's same-day rate (${comparisonRate.toFixed(3)}%) by more than ` +
    `${PLAUSIBILITY_THRESHOLD_POINTS.toFixed(1)} percentage point(s) on ${snapshotDate || '(unknown)'}. Excluded from pricing — LoanFactory's rate is ` +
    'used instead for this product today. Check the Provident ingest (comp/fee assumptions) and the raw grid for that date.',
    env
  );
}
