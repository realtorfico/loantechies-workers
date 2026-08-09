// Port of Loans/ProvidentRatesProvider.cs — derives LoanTechies' advertisable rate/APR from
// Provident's private wholesale grid for the estimate-rate merge (see loanFactoryRatesProvider.js).
// Conforming 30F maps to the (Conventional, Primary Residence) Purchase-30yr branch; 15F to the
// direct-15yr comparison. Best-effort like Rocket Pro: missing/stale/unparseable => excluded from
// the merge, never a hard failure.
//
// ANCHORING: Provident's grid is BASE PRICING (before LLPA adjustments) — the zero-LLPA/top-tier
// par. The estimate engine treats a branch rate as the par AT (anchorCreditScore, anchorLtv), so
// the anchor cell's LLPA is added back to the derived rate before the lower-wins merge, making
// Provident apples-to-apples with LoanFactory/Rocket Pro.
import { getLatestGrids } from './externalRates.js';
import { derive, defaultProvidentConfig } from './providentPricing.js';
import { computeLlpaDelta } from './rateConfig.js';
import { pacificDateOf, daysBetween } from './pacificDate.js';

const MAX_FAILOVER_DAYS = 7; // matches loanFactoryRatesProvider's Rocket Pro policy
const PRIMARY_CONV_KEY = 'Conventional::Primary Residence';

// Rate to add to Provident's base-pricing par to bring it to the estimate engine's
// (anchorCreditScore, anchorLtv) anchor. Pure/exported for unit testing. 0 if the matrix is
// unseeded (degrades to base pricing).
export function anchorAdjustment(cfg) {
  return -computeLlpaDelta(cfg, '780+', 50.0, 'Conventional');
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export async function loadAsync(cfg, env) {
  const { grids, date } = await getLatestGrids(env);
  if (!grids) return { branch30: null, direct15yr: null, snapshotDate: date };

  // Staleness: exclude if older than MAX_FAILOVER_DAYS (Pacific), same policy as Rocket Pro.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    const ageDays = daysBetween(pacificDateOf(new Date()), date);
    if (ageDays > MAX_FAILOVER_DAYS) return { branch30: null, direct15yr: null, snapshotDate: date };
  }

  const pricingCfg = defaultProvidentConfig(); // comp 1.25% LPC, $800k, $1225 fees, 30-day lock
  const adj = anchorAdjustment(cfg); // base pricing -> anchor scenario
  let branch30 = null;
  let direct15yr = null;

  if (grids.Conforming30F) {
    const a = derive('Conforming30F', grids.Conforming30F, pricingCfg);
    if (a?.apr != null) branch30 = { [PRIMARY_CONV_KEY]: { rate: round4(a.rate + adj), apr: round4(a.apr + adj) } };
  }
  if (grids.Conforming15F) {
    const a = derive('Conforming15F', grids.Conforming15F, pricingCfg);
    if (a?.apr != null) direct15yr = { [PRIMARY_CONV_KEY]: { rate: round4(a.rate + adj), apr: round4(a.apr + adj) } };
  }

  return { branch30, direct15yr, snapshotDate: date };
}
