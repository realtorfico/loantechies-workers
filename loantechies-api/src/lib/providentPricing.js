// Port of Loans/ProvidentPricing.cs — pure pricing engine that turns Provident Funding's WHOLESALE
// rate/price grid into a single ADVERTISABLE note rate + Reg Z APR per product, under a fixed
// Lender-Paid Comp (LPC) model. Side-effect-free.
import { solveApr } from './regZApr.js';

// cfg shape: { compPct = 1.25, loanAmount = 800000, fixedFees = 1225, lock = "30", neverBelowRate = false }
export function defaultProvidentConfig() {
  return { compPct: 1.25, loanAmount: 800000, fixedFees: 1225, lock: '30', neverBelowRate: false };
}

// row shape: { rate, base, lock21, lock30 } — prices are POINTS (>0 = borrower cost, <0 = rebate).
export function priceAt(row, lockKey) {
  if (lockKey === 'Base') return row.base;
  if (lockKey === '21') return row.lock21;
  return row.lock30;
}

// 15-year products amortize over 180 months; everything else 360.
export function termFor(product) {
  return product && product.includes('15') ? 180 : 360;
}

// Net cost to the borrower at a rate: fees + (comp + price)/100 * loan. Positive = borrower pays;
// negative = lender credit (no-cost).
export function netCost(row, cfg) {
  return cfg.fixedFees + ((cfg.compPct + priceAt(row, cfg.lock)) / 100.0) * cfg.loanAmount;
}

// Derive the advertisable rate + APR for one product's grid. Returns null for an empty grid.
export function derive(product, rows, cfg) {
  if (!rows || rows.length === 0) return null;
  cfg = cfg || defaultProvidentConfig();

  let pool = rows;
  if (cfg.neverBelowRate) {
    const nonNeg = rows.filter((r) => netCost(r, cfg) >= 0);
    if (nonNeg.length > 0) pool = nonNeg; // else fall back to the full grid
  }

  // Closest to $0 net cost; tie-break toward the >= 0 side (so APR >= rate on a tie), then lowest rate.
  const best = [...pool].sort((a, b) => {
    const da = Math.abs(netCost(a, cfg));
    const db = Math.abs(netCost(b, cfg));
    if (da !== db) return da - db;
    const sideA = netCost(a, cfg) >= 0 ? 0 : 1;
    const sideB = netCost(b, cfg) >= 0 ? 0 : 1;
    if (sideA !== sideB) return sideA - sideB;
    return a.rate - b.rate;
  })[0];

  const price = priceAt(best, cfg.lock);
  const rebate = -price;
  const netCostVal = netCost(best, cfg);
  const term = termFor(product);

  // Reg Z actuarial APR: express the prepaid finance charge as a fraction of loan amount. A net
  // credit (fraction <= 0) yields APR = rate — the clean "pin APR to the rate" outcome for a
  // no-cost loan.
  const fraction = netCostVal / cfg.loanAmount;
  const apr = solveApr(best.rate, term, fraction);

  return {
    rate: best.rate,
    apr: apr != null ? Math.round(apr * 1000) / 1000 : null,
    term,
    wholesalePrice: price,
    rebatePts: Math.round(rebate * 1000) / 1000,
    compPts: cfg.compPct,
    borrowerCredit: Math.round(((rebate - cfg.compPct) / 100.0) * cfg.loanAmount * 100) / 100,
    fixedFees: cfg.fixedFees,
    netToBorrower: Math.round(netCostVal * 100) / 100,
  };
}
