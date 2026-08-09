// Port of Utils/CalcMath.cs — shared math/parse helpers + sanity bounds for the loan calculators.
// Formulas kept bit-for-bit equivalent to the C# (same zero-rate branches, same rounding points).
import { roundHalfEven } from './mathRound.js';

export function getDouble(value, defaultValue = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : defaultValue;
}

export function getUint(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null; // null = "failed to parse", mirrors uint.TryParse's false
}

export function getInt(value, defaultValue) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

// Standard fully-amortizing monthly payment (principal + interest). periodRate is per-period
// (e.g. annual/12); periods is the total number of payments. Zero rate -> straight-line.
export function monthlyPI(loan, periodRate, periods) {
  return periodRate > 0
    ? (loan * periodRate) / (1 - Math.pow(1 + periodRate, -periods))
    : loan / periods;
}

// Present value of a payment stream — inverse of monthlyPI.
export function loanFromPayment(payment, periodRate, periods) {
  return periodRate > 0
    ? (payment * (1 - Math.pow(1 + periodRate, -periods))) / periodRate
    : payment * periods;
}

// ---- Sanity bounds for calculator inputs (deliberately generous — see CalcMath.cs) ----
export const MAX_DOLLAR_AMOUNT = 100_000_000;
export const MAX_RATE_PERCENT = 30;
export const MIN_TERM_YEARS = 1;
export const MAX_TERM_YEARS = 50;
export const MAX_PAYMENTS_PER_TERM = 366;
export const MIN_ECONOMIC_PERCENT = -25;
export const MAX_ECONOMIC_PERCENT = 30;
export const MAX_PROPERTY_TAX_PERCENT = 10;

export const isSaneAmount = (v) => v >= 0 && v <= MAX_DOLLAR_AMOUNT;
export const isSaneRate = (pct) => pct >= 0 && pct <= MAX_RATE_PERCENT;
export const isSaneTerm = (years) => years >= MIN_TERM_YEARS && years <= MAX_TERM_YEARS;
export const isSaneEconomicPercent = (pct) => pct >= MIN_ECONOMIC_PERCENT && pct <= MAX_ECONOMIC_PERCENT;
export const isSanePropertyTaxRate = (pct) => pct >= 0 && pct <= MAX_PROPERTY_TAX_PERCENT;
export const isSanePercentZeroToHundred = (pct) => pct >= 0 && pct <= 100;

export const round2 = (v) => roundHalfEven(v, 2);
