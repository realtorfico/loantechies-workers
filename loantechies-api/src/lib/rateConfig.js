// Port of Config/RateConfig.cs — the admin-editable estimated-rate pricing/eligibility engine.
// Pure, side-effect-free (storage lives in configStore.js's app_config table, key
// "estimated-rate"), mirroring the C#'s own "pure engine + separate store" split.
//
// DELIBERATE SCOPE CUT: the C# source carries a large amount of code explicitly marked
// [Obsolete] from the 2026-07-02 LoanFactory rate-engine migration, documented there as kept
// only for a "~2-week grace period" — which, as of this port, ended over a month ago (migration
// 2026-07-02, this port 2026-08-xx) and is confirmed "no longer read on any live pricing path"
// by the C# comments themselves. This port omits that dead weight entirely rather than
// faithfully reproducing code its own author documented as unused:
//   - RateOffset / RateOffsetPurchase*/Refinance* (superseded by Delta*AddOn fields)
//   - FallbackRate7 / FallbackRate5 (ARM dropped from the estimate flow; blocked by eligibility)
//   - OccupancyAdj / OccupancyAdjMatrix / ComputeOccupancyAdj / EnsureOccupancyMatrix
//     (occupancy differentials are now baked into LoanFactory's own per-occupancy quotes)
//   - EnsureOffsets / OffsetFor (superseded by Delta*AddOn fields)
//   - RefiGuardrails.Arm7 / Arm5 (ARM dropped — CheckConventionalRefiGuardrails only checks Yr15)
// If a stored config still has these legacy keys from before this migration, they're simply
// ignored here — never read, never required, never re-validated.

export const CREDIT_TIERS = ['780+', '760-779', '740-759', '720-739', '700-719', '680-699', '660-679', '640-659', '620-639'];
export const LTV_COLUMN_LABELS = ['≤60', '60.01-70', '70.01-75', '75.01-80', '80.01-85', '85.01-90', '90.01-95', '95.01-97'];
export const OCCUPANCY_TYPES = ['Primary Residence', 'Second Home', 'Investment Property'];
export const LOAN_TYPES = ['Conventional', 'FHA', 'VA', 'USDA'];

const FIELD_TYPES = {
  creditScore: 'number', ltv: 'number', cltv: 'number', term: 'number',
  occupancy: 'enum', loanType: 'enum', refinance: 'bool',
};
const ENUM_VALUES = { occupancy: OCCUPANCY_TYPES, loanType: LOAN_TYPES };
const NUMBER_OPS = ['<', '<=', '>', '>=', '==', '!='];
const ENUM_OPS = ['==', '!=', 'in', 'notIn'];
const BOOL_OPS = ['=='];

export const BOUNDS = {
  fallbackMin: 0.01, fallbackMax: 25,
  matrixMin: 0, matrixMax: 10, // LLPA + GovAdj cells (points)
  cltvAmtMin: 0, cltvAmtMax: 5,
  cltvLtvMin: 0, cltvLtvMax: 100,
  curvePtsMin: 0, curvePtsMax: 4,
  curveStepMax: 1.0,
  curveStepsMax: 6,
  guardrailMin: -2.0, guardrailMax: 2.0,
  anchorCreditMin: 300, anchorCreditMax: 850,
  anchorLtvMin: 0, anchorLtvMax: 100,
  deltaMin: -5, deltaMax: 5,
};

// ---- Defaults (seed source only — NOT a runtime fallback) ----

export function defaults() {
  return {
    anchorCreditScore: 759,
    anchorLtv: 80.0,
    deltaRefi30AddOn: 0.2,
    deltaInvSecondHomeRefi30AddOn: 0.25,
    deltaPurchase15AddOn: -0.5,
    deltaRefi15AddOn: -0.5,
    fallbackRate30: 6.75,
    fallbackRate15: 6.0,
    // Source: Fannie Mae LLPA Matrix — Purchase Money Loans (Table 1), effective 2026-01-28.
    // The 90.01-95 / 95.01-97 columns are a PLACEHOLDER duplicate of 85.01-90 (no data invented
    // — see Config/RateConfig.cs's original comment); enter real values via the admin UI.
    llpa: {
      '780+': [0.000, 0.000, 0.000, 0.375, 0.375, 0.250, 0.250, 0.250],
      '760-779': [0.000, 0.000, 0.250, 0.625, 0.625, 0.500, 0.500, 0.500],
      '740-759': [0.000, 0.125, 0.375, 0.875, 1.000, 0.750, 0.750, 0.750],
      '720-739': [0.000, 0.250, 0.750, 1.250, 1.250, 1.000, 1.000, 1.000],
      '700-719': [0.000, 0.375, 0.875, 1.375, 1.500, 1.250, 1.250, 1.250],
      '680-699': [0.000, 0.625, 1.125, 1.750, 1.875, 1.500, 1.500, 1.500],
      '660-679': [0.000, 0.750, 1.375, 1.875, 2.125, 1.750, 1.750, 1.750],
      '640-659': [0.000, 1.125, 1.500, 2.250, 2.500, 2.000, 2.000, 2.000],
      '620-639': [0.125, 1.500, 2.125, 2.750, 2.875, 2.625, 2.625, 2.625],
    },
    // FHA/VA/USDA adjuster — seeded to zeros (no effect until the MLO enters real values).
    govAdj: Object.fromEntries(CREDIT_TIERS.map((t) => [t, new Array(LTV_COLUMN_LABELS.length).fill(0)])),
    cltvSurcharge: { amount: 0.125, minFirstLienLtv: 80 },
    // 9 rungs: par ±4 x 0.125% -> points at 0.5 / 1.0 / 1.5 / 2.0 each side.
    pricingCurve: { costPointsPerQuarter: 1.0, creditPointsPerQuarter: 0.85, stepPct: 0.125, stepsEachWay: 4 },
    // Refi guardrail bands v2 (2026-06-29) — Yr15 only; Arm7/Arm5 dropped (see module doc comment).
    refiGuardrails: {
      version: 2,
      yr15: { vsPurchaseMin: 0.125, vsPurchaseMax: 0.375, vs30yrMin: -0.850, vs30yrMax: -0.500 },
    },
    eligibilityRules: [
      { id: 'min-credit', enabled: true, message: 'Conventional financing typically requires a minimum credit score of 620.', conditions: [{ field: 'creditScore', op: '<', value: '620' }] },
      { id: 'max-ltv', enabled: true, message: 'The loan-to-value ratio exceeds 96.5%, the maximum supported by this estimate.', conditions: [{ field: 'ltv', op: '>', value: '96.5' }] },
      { id: 'max-cltv', enabled: true, message: 'The loan-to-value ratio exceeds 96.5%, the maximum supported by this estimate.', conditions: [{ field: 'cltv', op: '>', value: '96.5' }] },
      { id: 'govt-primary-only', enabled: true, message: '{loanType} loans are available for primary residences only.', conditions: [{ field: 'loanType', op: 'in', value: 'FHA,VA,USDA' }, { field: 'occupancy', op: '!=', value: 'Primary Residence' }] },
      { id: 'fha-va-refi-unsupported', enabled: true, message: '{loanType} refinance is not currently supported by this estimate.', conditions: [{ field: 'loanType', op: 'in', value: 'FHA,VA' }, { field: 'refinance', op: '==', value: 'true' }] },
      { id: 'investment-15yr-unsupported', enabled: true, message: '15-year fixed is not currently offered for investment properties.', conditions: [{ field: 'loanType', op: '==', value: 'Conventional' }, { field: 'occupancy', op: '==', value: 'Investment Property' }, { field: 'term', op: '==', value: '15' }] },
      { id: 'second-home-15yr-unsupported', enabled: true, message: '15-year fixed is not currently offered for second homes.', conditions: [{ field: 'loanType', op: '==', value: 'Conventional' }, { field: 'occupancy', op: '==', value: 'Second Home' }, { field: 'term', op: '==', value: '15' }] },
      { id: 'arm7-unsupported', enabled: true, message: '7-year ARM is not currently offered.', conditions: [{ field: 'term', op: '==', value: '7' }] },
      { id: 'arm5-unsupported', enabled: true, message: '5-year ARM is not currently offered.', conditions: [{ field: 'term', op: '==', value: '5' }] },
    ],
  };
}

// ---- Backfill / healing (heal on load; not persisted until the next admin save) ----

export function ensureFallbackDefaults(cfg) {
  if (!cfg) return;
  const d = defaults();
  if (!(cfg.fallbackRate30 > 0)) cfg.fallbackRate30 = d.fallbackRate30;
  if (!(cfg.fallbackRate15 > 0)) cfg.fallbackRate15 = d.fallbackRate15;
}

export function ensureLoanFactoryDefaults(cfg) {
  if (!cfg) return;
  const d = defaults();
  if (cfg.anchorCreditScore == null) cfg.anchorCreditScore = d.anchorCreditScore;
  if (cfg.anchorLtv == null) cfg.anchorLtv = d.anchorLtv;
  if (cfg.deltaRefi30AddOn == null) cfg.deltaRefi30AddOn = d.deltaRefi30AddOn;
  if (cfg.deltaInvSecondHomeRefi30AddOn == null) cfg.deltaInvSecondHomeRefi30AddOn = d.deltaInvSecondHomeRefi30AddOn;
  if (cfg.deltaPurchase15AddOn == null) cfg.deltaPurchase15AddOn = d.deltaPurchase15AddOn;
  if (cfg.deltaRefi15AddOn == null) cfg.deltaRefi15AddOn = d.deltaRefi15AddOn;
}

// Heal LLPA/GovAdj rows saved before the 2026-07-02 8-column LTV split, by duplicating the old
// combined column's value into the new slots (preserves prior behavior exactly).
export function ensureLtvColumnMigration(cfg) {
  if (!cfg) return;
  const width = LTV_COLUMN_LABELS.length;
  const pad = (matrix) => {
    if (!matrix) return;
    for (const key of Object.keys(matrix)) {
      let row = matrix[key];
      if (!row) { matrix[key] = new Array(width).fill(0); continue; }
      if (row.length === width) continue;
      if (row.length > width) { matrix[key] = row.slice(0, width); continue; }
      const padded = new Array(width).fill(0);
      for (let i = 0; i < row.length; i++) padded[i] = row[i];
      const fill = row.length > 0 ? row[row.length - 1] : 0.0;
      for (let i = row.length; i < width; i++) padded[i] = fill;
      matrix[key] = padded;
    }
  };
  pad(cfg.llpa);
  pad(cfg.govAdj);
}

const LOAN_FACTORY_MIGRATION_RULE_IDS = ['fha-va-refi-unsupported', 'investment-15yr-unsupported', 'second-home-15yr-unsupported', 'arm7-unsupported', 'arm5-unsupported'];

export function ensureEligibilityRules(cfg) {
  if (!cfg) return;
  cfg.eligibilityRules = cfg.eligibilityRules || [];
  const have = new Set(cfg.eligibilityRules.filter(Boolean).map((r) => (r.id || '').toLowerCase()));
  const d = defaults();
  for (const id of LOAN_FACTORY_MIGRATION_RULE_IDS) {
    if (have.has(id.toLowerCase())) continue;
    const rule = d.eligibilityRules.find((r) => r.id === id);
    if (rule) cfg.eligibilityRules.push(rule);
  }
}

// Fallback rate for a product term. 15-yr uses fallbackRate15; everything else (30-yr, and the
// dead 7/5 ARM cases which are blocked by eligibility) uses fallbackRate30.
export function fallbackFor(cfg, term) {
  return term === 15 ? cfg.fallbackRate15 : cfg.fallbackRate30;
}

export const CURRENT_GUARDRAIL_VERSION = 2;

function hasNonZeroBand(b) {
  return !!b && (b.vsPurchaseMin !== 0 || b.vsPurchaseMax !== 0 || b.vs30yrMin !== 0 || b.vs30yrMax !== 0);
}

export function ensureRefiGuardrails(cfg) {
  if (!cfg) return;
  const hasValues = cfg.refiGuardrails && hasNonZeroBand(cfg.refiGuardrails.yr15) && cfg.refiGuardrails.version >= CURRENT_GUARDRAIL_VERSION;
  if (!hasValues) cfg.refiGuardrails = defaults().refiGuardrails;
}

function isSane(v, min, max) {
  return Number.isFinite(v) && v >= min && v <= max;
}

function healCurve(c, d) {
  if (!isSane(c.costPointsPerQuarter, BOUNDS.curvePtsMin, BOUNDS.curvePtsMax)) c.costPointsPerQuarter = d.costPointsPerQuarter;
  if (!isSane(c.creditPointsPerQuarter, BOUNDS.curvePtsMin, BOUNDS.curvePtsMax)) c.creditPointsPerQuarter = d.creditPointsPerQuarter;
  if (!(c.stepPct > 0 && c.stepPct <= BOUNDS.curveStepMax)) c.stepPct = d.stepPct;
  if (c.stepsEachWay < 1 || c.stepsEachWay > BOUNDS.curveStepsMax) c.stepsEachWay = d.stepsEachWay;
  // Migrate old default (0.25 / 2 = 5 rungs) to half-point ladder (0.125 / 4 = 9 rungs).
  if (c.stepPct === 0.25 && c.stepsEachWay === 2) { c.stepPct = 0.125; c.stepsEachWay = 4; }
}

export function ensurePricingCurve(cfg) {
  if (!cfg) return;
  const d = defaults().pricingCurve;
  if (!cfg.pricingCurve) { cfg.pricingCurve = { ...d }; return; }
  healCurve(cfg.pricingCurve, d);
  if (cfg.pricingCurveOverrides) {
    for (const key of Object.keys(cfg.pricingCurveOverrides)) {
      if (!cfg.pricingCurveOverrides[key]) { delete cfg.pricingCurveOverrides[key]; continue; }
      healCurve(cfg.pricingCurveOverrides[key], d);
    }
  }
}

// Rough APR impact of 1 discount point on a 30-yr loan, scaled inversely with term. Intentionally
// a simple, transparent approximation — NOT Reg-Z compliant — non-par rungs are always "approx".
const APR_PCT_PER_POINT_ON_30YR = 0.125;

export function effectiveCurve(cfg, loanType) {
  if (loanType && cfg?.pricingCurveOverrides?.[loanType]) return cfg.pricingCurveOverrides[loanType];
  return cfg?.pricingCurve || defaults().pricingCurve;
}

// The rate/price ladder for one product: par in the middle, stepsEachWay rungs of stepPct on each
// side. Below par = discount points (cost, points > 0); above par = lender credit (points < 0).
export function computeLadder(cfg, parRate, parApr, parAprKnown, term, loanType = null) {
  const curve = effectiveCurve(cfg, loanType);
  const step = curve.stepPct > 0 ? curve.stepPct : 0.25;
  const each = curve.stepsEachWay >= 1 ? curve.stepsEachWay : 2;
  const quartersPerStep = step / 0.25;
  const aprSpread = parAprKnown ? parApr - parRate : 0.0;
  const termYears = term === 15 ? 15.0 : 30.0;
  const aprPerPoint = APR_PCT_PER_POINT_ON_30YR * (30.0 / termYears);

  const rungs = [];
  for (let s = -each; s <= each; s++) {
    const rate = parRate + s * step;
    const points = s < 0 ? -s * quartersPerStep * curve.costPointsPerQuarter
      : s > 0 ? -s * quartersPerStep * curve.creditPointsPerQuarter
        : 0.0;
    const isPar = s === 0;
    const apr = rate + aprSpread + points * aprPerPoint;
    rungs.push({
      rate: Math.round(rate * 10000) / 10000,
      points: Math.round(points * 10000) / 10000,
      apr: Math.round(apr * 10000) / 10000,
      aprApprox: !isPar || !parAprKnown,
      par: isPar,
    });
  }
  return rungs;
}

export function builderMeta() {
  return {
    fields: Object.entries(FIELD_TYPES).map(([name, type]) => ({ name, type })),
    operators: { number: NUMBER_OPS, enum: ENUM_OPS, bool: BOOL_OPS },
    enums: ENUM_VALUES,
    creditTiers: CREDIT_TIERS,
    ltvColumns: LTV_COLUMN_LABELS,
    occupancyTypes: OCCUPANCY_TYPES,
    loanTypes: LOAN_TYPES,
    limits: {
      fallback: { min: BOUNDS.fallbackMin, max: BOUNDS.fallbackMax },
      matrix: { min: BOUNDS.matrixMin, max: BOUNDS.matrixMax },
      cltvAmount: { min: BOUNDS.cltvAmtMin, max: BOUNDS.cltvAmtMax },
      cltvMinLtv: { min: BOUNDS.cltvLtvMin, max: BOUNDS.cltvLtvMax },
      curvePoints: { min: BOUNDS.curvePtsMin, max: BOUNDS.curvePtsMax },
      curveStep: { min: 0.0, max: BOUNDS.curveStepMax },
      curveSteps: { min: 1, max: BOUNDS.curveStepsMax },
      guardrail: { min: BOUNDS.guardrailMin, max: BOUNDS.guardrailMax },
      anchorCredit: { min: BOUNDS.anchorCreditMin, max: BOUNDS.anchorCreditMax },
      anchorLtv: { min: BOUNDS.anchorLtvMin, max: BOUNDS.anchorLtvMax },
      delta: { min: BOUNDS.deltaMin, max: BOUNDS.deltaMax },
    },
  };
}

// ---- Credit tier <-> representative numeric score ----

export function tierToScore(creditLabel) {
  switch ((creditLabel || '').trim()) {
    case '780+': return 780;
    case '760-779': return 760;
    case '740-759': return 740;
    case '720-739': return 720;
    case '700-719': return 700;
    case '680-699': return 680;
    case '660-679': return 660;
    case '640-659': return 640;
    case '620-639': return 620;
    case 'Below 620': return 0;
    case 'Not sure': return 640; // conservative — matches the LLPA lookup fallback
    default: return 640; // unknown label: treat as conservative, never blocks on credit
  }
}

export function tierForScore(score) {
  if (score >= 780) return '780+';
  if (score >= 760) return '760-779';
  if (score >= 740) return '740-759';
  if (score >= 720) return '720-739';
  if (score >= 700) return '700-719';
  if (score >= 680) return '680-699';
  if (score >= 660) return '660-679';
  if (score >= 640) return '640-659';
  return '620-639';
}

// ---- Pricing deltas (Conventional only; FHA/VA/USDA have their own MI pricing) ----

function ltvColumn(ltv) {
  if (ltv <= 60) return 0;
  if (ltv <= 70) return 1;
  if (ltv <= 75) return 2;
  if (ltv <= 80) return 3;
  if (ltv <= 85) return 4;
  if (ltv <= 90) return 5;
  if (ltv <= 95) return 6;
  return 7;
}

// LLPA rate delta = matrix points / 4, rebased around (anchorCreditScore, anchorLtv) so that cell
// is zero. 0 for non-Conventional or unknown credit.
export function computeLlpaDelta(cfg, creditLabel, ltv, loanType) {
  if (loanType !== 'Conventional') return 0.0;
  return matrixDelta(cfg, cfg?.llpa, creditLabel, ltv);
}

// Government-loan (FHA/VA/USDA) credit x LTV adjustment = matrix points / 4, same rebase. 0 otherwise.
export function computeGovAdj(cfg, creditLabel, ltv, loanType) {
  if (loanType !== 'FHA' && loanType !== 'VA' && loanType !== 'USDA') return 0.0;
  return matrixDelta(cfg, cfg?.govAdj, creditLabel, ltv);
}

function matrixDelta(cfg, matrix, creditLabel, ltv) {
  const row = matrix?.[creditLabel || ''];
  if (!row) return 0.0;
  const col = ltvColumn(ltv);
  if (col >= row.length) return 0.0;

  const anchorTier = tierForScore(cfg?.anchorCreditScore ?? 759);
  const anchorCol = ltvColumn(cfg?.anchorLtv ?? 80.0);
  let anchorVal = 0.0;
  const anchorRow = matrix?.[anchorTier];
  if (anchorRow && anchorCol < anchorRow.length) anchorVal = anchorRow[anchorCol];

  return Math.round(((row[col] - anchorVal) / 4.0) * 1000000) / 1000000;
}

// Alert-only guardrail check for the 15yr-Fixed refi product (the only one still checked post-ARM
// removal — see module doc comment). Empty = clean. Null inputs skip the check (unavailable rate).
export function checkConventionalRefiGuardrails(g, refi30yr, yr15Purchase, yr15Refi) {
  const violations = [];
  if (!g || refi30yr == null) return violations;

  const band = g.yr15;
  if (!band || yr15Purchase == null || yr15Refi == null) return violations;

  const vp = yr15Refi - yr15Purchase;
  const v3 = yr15Refi - refi30yr;
  const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(3);

  if (vp < band.vsPurchaseMin || vp > band.vsPurchaseMax) {
    const miss = vp < band.vsPurchaseMin ? vp - band.vsPurchaseMin : vp - band.vsPurchaseMax;
    violations.push(`15yr Fixed: refi vs purchase ${fmt(vp)}% outside [${fmt(band.vsPurchaseMin)}%, ${fmt(band.vsPurchaseMax)}%]\n      → ${fmt(miss)}% from nearest limit`);
  }
  if (v3 < band.vs30yrMin || v3 > band.vs30yrMax) {
    const miss = v3 < band.vs30yrMin ? v3 - band.vs30yrMin : v3 - band.vs30yrMax;
    violations.push(`15yr Fixed: refi vs 30yr refi ${fmt(v3)}% outside [${fmt(band.vs30yrMin)}%, ${fmt(band.vs30yrMax)}%]\n      → ${fmt(miss)}% from nearest limit`);
  }
  return violations;
}

export function computeCltvAdj(cfg, ltv, cltv) {
  const s = cfg?.cltvSurcharge;
  if (!s) return 0.0;
  return cltv > ltv && ltv >= s.minFirstLienLtv ? s.amount : 0.0;
}

// ---- Eligibility ----

// input shape: { creditLabel, ltv, cltv, occupancy, loanType, term, refinance }
export function evaluateEligibility(cfg, input) {
  if (!cfg?.eligibilityRules) return null;
  for (const rule of cfg.eligibilityRules) {
    if (!rule || !rule.enabled || !rule.conditions || rule.conditions.length === 0) continue;
    if (rule.conditions.every((c) => conditionMatches(c, input))) return interpolate(rule.message, input);
  }
  return null;
}

function conditionMatches(c, input) {
  if (!c || !c.field || !c.op) return false;
  const type = FIELD_TYPES[c.field];
  if (!type) return false;

  if (type === 'number') {
    const actual = numericField(c.field, input);
    const target = tryNum(c.value);
    if (target == null) return false;
    switch (c.op) {
      case '<': return actual < target;
      case '<=': return actual <= target;
      case '>': return actual > target;
      case '>=': return actual >= target;
      case '==': return actual === target;
      case '!=': return actual !== target;
      default: return false;
    }
  }

  if (type === 'enum') {
    const actual = (enumField(c.field, input) || '').trim();
    switch (c.op) {
      case '==': return eq(actual, c.value);
      case '!=': return !eq(actual, c.value);
      case 'in': return splitList(c.value).some((v) => eq(actual, v));
      case 'notIn': return !splitList(c.value).some((v) => eq(actual, v));
      default: return false;
    }
  }

  if (type === 'bool') {
    const actual = input.refinance;
    const target = (c.value || '').trim().toLowerCase();
    return c.op === '==' && (target === 'true' || target === 'false') && actual === (target === 'true');
  }

  return false;
}

function numericField(field, input) {
  switch (field) {
    case 'creditScore': return tierToScore(input.creditLabel);
    case 'ltv': return input.ltv;
    case 'cltv': return input.cltv;
    case 'term': return input.term;
    default: return NaN;
  }
}

function enumField(field, input) {
  switch (field) {
    case 'occupancy': return input.occupancy;
    case 'loanType': return input.loanType;
    default: return null;
  }
}

function eq(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

function splitList(v) {
  return (v || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function tryNum(s) {
  const t = (s || '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function interpolate(message, input) {
  if (!message) return message;
  return message
    .replace('{loanType}', input.loanType || '')
    .replace('{occupancy}', input.occupancy || '')
    .replace('{credit}', input.creditLabel || '')
    .replace('{ltv}', String(input.ltv))
    .replace('{cltv}', String(input.cltv));
}

// ---- Validation (admin POST gate; invalid config is never stored) ----
// Only validates the LIVE fields — see module doc comment on the deprecated-field scope cut.

export function validate(cfg) {
  const errors = [];
  if (!cfg) { errors.push('config: missing.'); return errors; }

  if (cfg.anchorCreditScore != null && !isSane(cfg.anchorCreditScore, BOUNDS.anchorCreditMin, BOUNDS.anchorCreditMax))
    errors.push(`anchorCreditScore: must be a number between ${BOUNDS.anchorCreditMin} and ${BOUNDS.anchorCreditMax}.`);
  if (cfg.anchorLtv != null && !isSane(cfg.anchorLtv, BOUNDS.anchorLtvMin, BOUNDS.anchorLtvMax))
    errors.push(`anchorLtv: must be a number between ${BOUNDS.anchorLtvMin} and ${BOUNDS.anchorLtvMax}.`);
  for (const [name, val] of [
    ['deltaRefi30AddOn', cfg.deltaRefi30AddOn], ['deltaInvSecondHomeRefi30AddOn', cfg.deltaInvSecondHomeRefi30AddOn],
    ['deltaPurchase15AddOn', cfg.deltaPurchase15AddOn], ['deltaRefi15AddOn', cfg.deltaRefi15AddOn],
  ]) {
    if (val != null && !isSane(val, BOUNDS.deltaMin, BOUNDS.deltaMax))
      errors.push(`${name}: must be a number between ${BOUNDS.deltaMin} and ${BOUNDS.deltaMax}.`);
  }

  if (!isSane(cfg.fallbackRate30, BOUNDS.fallbackMin, BOUNDS.fallbackMax)) errors.push(`fallbackRate30: must be a number between ${BOUNDS.fallbackMin} and ${BOUNDS.fallbackMax}.`);
  if (!isSane(cfg.fallbackRate15, BOUNDS.fallbackMin, BOUNDS.fallbackMax)) errors.push(`fallbackRate15: must be a number between ${BOUNDS.fallbackMin} and ${BOUNDS.fallbackMax}.`);

  validateMatrix(cfg.llpa, 'llpa', errors);
  validateMatrix(cfg.govAdj, 'govAdj', errors);

  if (!cfg.cltvSurcharge) errors.push('cltvSurcharge: missing.');
  else {
    if (!isSane(cfg.cltvSurcharge.amount, BOUNDS.cltvAmtMin, BOUNDS.cltvAmtMax)) errors.push(`cltvSurcharge.amount: must be a number between ${BOUNDS.cltvAmtMin} and ${BOUNDS.cltvAmtMax}.`);
    if (!isSane(cfg.cltvSurcharge.minFirstLienLtv, BOUNDS.cltvLtvMin, BOUNDS.cltvLtvMax)) errors.push(`cltvSurcharge.minFirstLienLtv: must be a number between ${BOUNDS.cltvLtvMin} and ${BOUNDS.cltvLtvMax}.`);
  }

  if (!cfg.pricingCurve) errors.push('pricingCurve: missing.');
  else validateCurve(cfg.pricingCurve, 'pricingCurve', errors);
  if (cfg.pricingCurveOverrides) {
    for (const [key, val] of Object.entries(cfg.pricingCurveOverrides))
      if (val) validateCurve(val, `pricingCurveOverrides['${key}']`, errors);
  }

  if (!cfg.refiGuardrails) errors.push('refiGuardrails: missing.');
  else validateGuardrailBand(cfg.refiGuardrails.yr15, 'refiGuardrails.yr15', errors);

  if (!cfg.eligibilityRules) errors.push('eligibilityRules: missing.');
  else {
    cfg.eligibilityRules.forEach((rule, r) => {
      const tag = `eligibilityRules[${r}]`;
      if (!rule) { errors.push(`${tag}: missing.`); return; }
      if (!rule.message || !rule.message.trim()) errors.push(`${tag}.message: required.`);
      if (!rule.conditions || rule.conditions.length === 0) { errors.push(`${tag}.conditions: at least one condition required.`); return; }
      rule.conditions.forEach((c, i) => validateCondition(c, `${tag}.conditions[${i}]`, errors));
    });
  }

  return errors;
}

function validateGuardrailBand(b, prefix, errors) {
  if (!b) { errors.push(`${prefix}: missing.`); return; }
  if (!isSane(b.vsPurchaseMin, BOUNDS.guardrailMin, BOUNDS.guardrailMax)) errors.push(`${prefix}.vsPurchaseMin: must be between ${BOUNDS.guardrailMin} and ${BOUNDS.guardrailMax}.`);
  if (!isSane(b.vsPurchaseMax, BOUNDS.guardrailMin, BOUNDS.guardrailMax)) errors.push(`${prefix}.vsPurchaseMax: must be between ${BOUNDS.guardrailMin} and ${BOUNDS.guardrailMax}.`);
  if (!isSane(b.vs30yrMin, BOUNDS.guardrailMin, BOUNDS.guardrailMax)) errors.push(`${prefix}.vs30yrMin: must be between ${BOUNDS.guardrailMin} and ${BOUNDS.guardrailMax}.`);
  if (!isSane(b.vs30yrMax, BOUNDS.guardrailMin, BOUNDS.guardrailMax)) errors.push(`${prefix}.vs30yrMax: must be between ${BOUNDS.guardrailMin} and ${BOUNDS.guardrailMax}.`);
  if (b.vsPurchaseMin > b.vsPurchaseMax) errors.push(`${prefix}: vsPurchaseMin must be ≤ vsPurchaseMax.`);
  if (b.vs30yrMin > b.vs30yrMax) errors.push(`${prefix}: vs30yrMin must be ≤ vs30yrMax.`);
}

function validateCurve(pc, prefix, errors) {
  if (!isSane(pc.costPointsPerQuarter, BOUNDS.curvePtsMin, BOUNDS.curvePtsMax)) errors.push(`${prefix}.costPointsPerQuarter: must be a number between ${BOUNDS.curvePtsMin} and ${BOUNDS.curvePtsMax}.`);
  if (!isSane(pc.creditPointsPerQuarter, BOUNDS.curvePtsMin, BOUNDS.curvePtsMax)) errors.push(`${prefix}.creditPointsPerQuarter: must be a number between ${BOUNDS.curvePtsMin} and ${BOUNDS.curvePtsMax}.`);
  if (!(pc.stepPct > 0 && pc.stepPct <= BOUNDS.curveStepMax)) errors.push(`${prefix}.stepPct: must be a number greater than 0 and at most ${BOUNDS.curveStepMax}.`);
  if (pc.stepsEachWay < 1 || pc.stepsEachWay > BOUNDS.curveStepsMax) errors.push(`${prefix}.stepsEachWay: must be a whole number between 1 and ${BOUNDS.curveStepsMax}.`);
}

function validateMatrix(m, name, errors) {
  if (!m) { errors.push(`${name}: missing.`); return; }
  for (const tier of CREDIT_TIERS) if (!(tier in m)) errors.push(`${name}: missing credit tier '${tier}'.`);
  for (const key of Object.keys(m)) if (!CREDIT_TIERS.includes(key)) errors.push(`${name}: unexpected credit tier '${key}'.`);
  for (const [key, row] of Object.entries(m)) {
    if (!row || row.length !== LTV_COLUMN_LABELS.length) { errors.push(`${name}['${key}']: must have exactly ${LTV_COLUMN_LABELS.length} values.`); continue; }
    row.forEach((v, i) => { if (!isSane(v, BOUNDS.matrixMin, BOUNDS.matrixMax)) errors.push(`${name}['${key}'][${i}]: must be a number between ${BOUNDS.matrixMin} and ${BOUNDS.matrixMax} points.`); });
  }
}

function validateCondition(c, tag, errors) {
  if (!c) { errors.push(`${tag}: missing.`); return; }
  const type = c.field ? FIELD_TYPES[c.field] : null;
  if (!c.field || !type) { errors.push(`${tag}.field: unknown field '${c.field}'.`); return; }

  const allowedOps = type === 'number' ? NUMBER_OPS : type === 'enum' ? ENUM_OPS : BOOL_OPS;
  if (!c.op || !allowedOps.includes(c.op)) { errors.push(`${tag}.op: operator '${c.op}' is not valid for ${type} field '${c.field}'.`); return; }

  if (type === 'number') {
    if (tryNum(c.value) == null) errors.push(`${tag}.value: '${c.value}' is not a number.`);
  } else if (type === 'bool') {
    const t = (c.value || '').trim().toLowerCase();
    if (t !== 'true' && t !== 'false') errors.push(`${tag}.value: '${c.value}' must be true or false.`);
  } else {
    if (splitList(c.value).length === 0) errors.push(`${tag}.value: required.`);
  }
}
