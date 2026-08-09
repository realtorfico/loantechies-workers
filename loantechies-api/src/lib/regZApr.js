// Port of Utils/RegZApr.cs — Regulation Z actuarial-method APR derivation, expressed as a points
// FRACTION of loan amount (provably loan-amount-independent — see the C# doc comment). Pure,
// side-effect-free, built on calcMath's annuity primitives.
import { monthlyPI, loanFromPayment } from './calcMath.js';

// Back-solve the implied finance-charge fraction from a genuine (noteRate, apr) pair at a known
// term — e.g. a LoanFactory-quoted Purchase-30yr-Fixed branch. Compute once per branch.
export function solveFinanceChargeFraction(notePct, aprPct, termMonths, loanAmount = 100000.0) {
  const noteRate = notePct / 1200.0;
  const aprRate = aprPct / 1200.0;
  const payment = monthlyPI(loanAmount, noteRate, termMonths);
  const amountFinanced = loanFromPayment(payment, aprRate, termMonths);
  return (loanAmount - amountFinanced) / loanAmount;
}

// Forward-solve the APR for a derived row given a branch's finance-charge fraction (from
// solveFinanceChargeFraction on that SAME branch's genuine pair — never chain a derived row's own
// solved APR into a further derivation). Not a closed form — bisection over the discount rate.
// Returns notePct unchanged when the fraction is non-positive (no fee to redistribute). Returns
// null — never a fabricated number — if the bisection fails to bracket a solution.
export function solveApr(notePct, termMonths, financeChargeFraction, loanAmount = 100000.0) {
  if (financeChargeFraction <= 0) return Math.round(notePct * 10000) / 10000;

  const noteRate = notePct / 1200.0;
  const payment = monthlyPI(loanAmount, noteRate, termMonths);
  const targetFinanced = loanAmount * (1 - financeChargeFraction);

  // loanFromPayment(payment, r, n) is strictly decreasing in r. At r = noteRate it equals
  // loanAmount exactly (by construction); since financeChargeFraction > 0, targetFinanced <
  // loanAmount, so the solution rate is > noteRate. Bracket generously, expanding if needed.
  let lo = noteRate;
  let hi = noteRate + 10.0 / 1200.0;
  let guard = 0;
  while (loanFromPayment(payment, hi, termMonths) > targetFinanced && guard < 20) {
    hi += 10.0 / 1200.0;
    guard++;
  }
  if (guard >= 20) return null;

  let mid = (lo + hi) / 2.0;
  for (let i = 0; i < 100; i++) {
    mid = (lo + hi) / 2.0;
    const pv = loanFromPayment(payment, mid, termMonths);
    if (Math.abs(pv - targetFinanced) < 1e-9) break;
    if (pv > targetFinanced) lo = mid;
    else hi = mid;
  }

  return Math.round(mid * 1200.0 * 10000) / 10000;
}
