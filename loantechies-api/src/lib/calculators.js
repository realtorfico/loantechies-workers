// Port of Loans/Calculators/*.cs — 8 pure-math calculator endpoints, no storage/auth involved.
// Anonymous everywhere, matching the C# (AuthorizationLevel.Anonymous on every route).
import { badRequest, ok } from './http.js';
import * as M from './calcMath.js';
import { roundHalfEven } from './mathRound.js';

// GET query params, falling back to a JSON body field for routes that also accept POST — mirrors
// each C# handler's `paramStr ??= data?.field?.ToString()` pattern. Body is read once per request.
async function readParams(request, url, names) {
  let body = null;
  if (request.method === 'POST') {
    try {
      const raw = await request.text();
      body = raw && raw.trim() ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
  }
  const out = {};
  for (const name of names) {
    const q = url.searchParams.get(name);
    out[name] = q != null ? q : body?.[name] != null ? String(body[name]) : null;
  }
  return out;
}

// ---- GET/POST loans/amortizationcalculator ----
export async function amortizationCalculator(request, env) {
  const url = new URL(request.url);
  const p = await readParams(request, url, ['loanAmt', 'rate', 'term', 'paymentsPerTerm', 'buydownList']);

  const loanAmt = M.getUint(p.loanAmt);
  const rate = M.getDouble(p.rate, NaN);
  const term = M.getUint(p.term);
  const paymentsPerTerm = M.getUint(p.paymentsPerTerm);

  if (
    loanAmt == null || loanAmt === 0 || loanAmt > M.MAX_DOLLAR_AMOUNT ||
    !Number.isFinite(rate) || rate < 0 || rate > M.MAX_RATE_PERCENT ||
    term == null || term === 0 || term > M.MAX_TERM_YEARS ||
    paymentsPerTerm == null || paymentsPerTerm === 0 || paymentsPerTerm > M.MAX_PAYMENTS_PER_TERM
  ) {
    return badRequest(
      `loanAmt must be positive and no more than ${M.MAX_DOLLAR_AMOUNT.toLocaleString()}; rate must be 0-${M.MAX_RATE_PERCENT}%; ` +
      `term must be 1-${M.MAX_TERM_YEARS} years; paymentsPerTerm must be 1-${M.MAX_PAYMENTS_PER_TERM}.`
    );
  }

  const buydownList = [];
  if (p.buydownList) {
    for (const s of p.buydownList.split(',')) {
      const b = parseInt(s, 10);
      if (Number.isFinite(b)) buydownList.push(b);
    }
  }

  const periodRate = rate / (paymentsPerTerm * 100);
  const pmt = rate === 0
    ? loanAmt / (term * paymentsPerTerm)
    : loanAmt * (periodRate / (1 - Math.pow(1 + periodRate, -(term * paymentsPerTerm))));

  const array = getAmortizationSchedule(loanAmt, term, rate, paymentsPerTerm, buydownList);
  return ok({ pmt, amortObj: { array } });
}

function getAmortizationSchedule(principal, term, rate, paymentsPerTerm, buydownList) {
  const totalPeriod = term * paymentsPerTerm;
  const fullPeriodRate = rate / (paymentsPerTerm * 100);
  const fullPayment = rate === 0
    ? principal / totalPeriod
    : (principal * fullPeriodRate) / (1 - Math.pow(1 + fullPeriodRate, -totalPeriod));

  const schedule = [];
  let balance = principal;
  let cumulativePrincipal = 0;
  let cumulativeInterest = 0;

  for (let year = 0; year < term; year++) {
    const inBuydown = year < buydownList.length;
    const effRate = inBuydown ? (rate - buydownList[year]) / (paymentsPerTerm * 100) : fullPeriodRate;
    const payment = !inBuydown ? fullPayment
      : (effRate === 0 ? principal / totalPeriod
        : (principal * effRate) / (1 - Math.pow(1 + effRate, -totalPeriod)));

    for (let p = 1; p <= paymentsPerTerm; p++) {
      const interest = balance * effRate;
      const principalPaid = payment - interest;
      balance -= principalPaid;
      cumulativePrincipal += principalPaid;
      cumulativeInterest += interest;

      schedule.push({
        period: year * paymentsPerTerm + p,
        payment,
        principal: principalPaid,
        interest,
        buydown: fullPayment - payment,
        balance,
        cumulativePrincipal,
        cumulativeInterest,
      });
    }
  }
  return schedule;
}

// ---- GET/POST loans/getloanamount ----
export async function affordabilityCalculator(request, env) {
  const url = new URL(request.url);
  const p = await readParams(request, url, ['payment', 'term', 'paymentsPerTerm', 'rate']);

  const pmt = M.getUint(p.payment);
  const rate = M.getDouble(p.rate, NaN);
  const term = M.getUint(p.term);
  const paymentsPerTerm = M.getUint(p.paymentsPerTerm);

  if (
    pmt == null || pmt === 0 || pmt > M.MAX_DOLLAR_AMOUNT ||
    !Number.isFinite(rate) || rate < 0 || rate > M.MAX_RATE_PERCENT ||
    term == null || term === 0 || term > M.MAX_TERM_YEARS ||
    paymentsPerTerm == null || paymentsPerTerm === 0 || paymentsPerTerm > M.MAX_PAYMENTS_PER_TERM
  ) {
    return badRequest(
      `payment must be positive and no more than ${M.MAX_DOLLAR_AMOUNT.toLocaleString()}; rate must be 0-${M.MAX_RATE_PERCENT}%; ` +
      `term must be 1-${M.MAX_TERM_YEARS} years; paymentsPerTerm must be 1-${M.MAX_PAYMENTS_PER_TERM}.`
    );
  }

  const periodRate = rate / (paymentsPerTerm * 100);
  const loanAmt = rate === 0
    ? pmt * term * paymentsPerTerm
    : pmt / (periodRate / (1 - Math.pow(1 + periodRate, -(term * paymentsPerTerm))));

  return ok({ loanAmt });
}

// ---- GET loans/dticalculator ----
export function dtiCalculator(request, env) {
  const url = new URL(request.url);
  const primaryIncome = M.getDouble(url.searchParams.get('primaryIncome'));
  const spouseIncome = M.getDouble(url.searchParams.get('spouseIncome'));
  const housingExp = M.getDouble(url.searchParams.get('housingExpense'));
  const otherHousing = M.getDouble(url.searchParams.get('otherHousing'));
  const otherDebts = M.getDouble(url.searchParams.get('otherDebts'));

  if (
    !M.isSaneAmount(primaryIncome) || !M.isSaneAmount(spouseIncome) ||
    !M.isSaneAmount(housingExp) || !M.isSaneAmount(otherHousing) || !M.isSaneAmount(otherDebts)
  ) {
    return badRequest('All income and expense values must be zero or a positive dollar amount.');
  }

  const totalGrossIncome = primaryIncome + spouseIncome;
  const totalHousing = housingExp + otherHousing;
  const totalMonthlyDebt = totalHousing + otherDebts;

  let frontEndRatio = 0;
  let backEndRatio = 0;
  if (totalGrossIncome > 0) {
    frontEndRatio = (totalHousing / totalGrossIncome) * 100;
    backEndRatio = (totalMonthlyDebt / totalGrossIncome) * 100;
  }

  return ok({
    totalGrossIncome: M.round2(totalGrossIncome),
    totalHousing: M.round2(totalHousing),
    totalMonthlyDebt: M.round2(totalMonthlyDebt),
    frontEndRatio: M.round2(frontEndRatio),
    backEndRatio: M.round2(backEndRatio),
  });
}

// ---- GET loans/affordability ----
const COMFORTABLE_DTI = 0.36;
const MAX_DTI = 0.43;
const FRONTEND_GUIDE = 0.28; // secondary check, not a price cap
const PMI_ANNUAL_RATE = 0.005; // ~0.5%/yr of loan when LTV > 80%

export function affordabilityEstimator(request, env) {
  const url = new URL(request.url);
  const annualIncome = M.getDouble(url.searchParams.get('annualIncome'));
  const monthlyDebts = M.getDouble(url.searchParams.get('monthlyDebts'));
  const downPayment = M.getDouble(url.searchParams.get('downPayment'));
  const intRate = M.getDouble(url.searchParams.get('intRate'));
  const term = M.getDouble(url.searchParams.get('term'));
  const taxRate = M.getDouble(url.searchParams.get('taxRate'));
  const insuranceYr = M.getDouble(url.searchParams.get('insuranceYr'));
  const hoaMonthly = M.getDouble(url.searchParams.get('hoaMonthly'));
  const melloRoosMonthly = M.getDouble(url.searchParams.get('melloRoosMonthly'));

  if (
    !M.isSaneAmount(annualIncome) || !M.isSaneAmount(monthlyDebts) ||
    !M.isSaneAmount(downPayment) || !M.isSaneRate(intRate) ||
    !M.isSaneTerm(term) || !M.isSanePropertyTaxRate(taxRate) ||
    !M.isSaneAmount(insuranceYr) || !M.isSaneAmount(hoaMonthly) || !M.isSaneAmount(melloRoosMonthly)
  ) {
    return badRequest(
      'One or more inputs are out of range (negative amount, interest rate over ' +
      `${M.MAX_RATE_PERCENT}%, term outside ${M.MIN_TERM_YEARS}-${M.MAX_TERM_YEARS} years, ` +
      `or property tax rate over ${M.MAX_PROPERTY_TAX_PERCENT}%).`
    );
  }

  const monthlyIncome = annualIncome / 12.0;
  const comfortable = solveTier(COMFORTABLE_DTI, monthlyIncome, monthlyDebts, downPayment, intRate, term, taxRate, insuranceYr, hoaMonthly, melloRoosMonthly);
  const max = solveTier(MAX_DTI, monthlyIncome, monthlyDebts, downPayment, intRate, term, taxRate, insuranceYr, hoaMonthly, melloRoosMonthly);

  const limitingFactor = max.loan <= 0 ? 'down payment / debts' : 'back-end DTI';
  const frontEndExceeded = max.frontEndDti > FRONTEND_GUIDE;

  return ok({
    comfortable: tierToResult(comfortable),
    max: tierToResult(max),
    downPayment: M.round2(downPayment),
    monthlyIncome: M.round2(monthlyIncome),
    limitingFactor,
    frontEndExceeded,
  });
}

// Solve one DTI tier. Iterates because property tax and PMI scale with the price/loan being
// solved for (a circular dependency); ~6 passes converge.
function solveTier(backEndDti, monthlyIncome, monthlyDebts, downPayment, intRatePct, termYears, taxRatePct, insuranceYr, hoaMonthly, melloRoosMonthly) {
  const r = intRatePct / 100.0 / 12.0;
  const n = termYears * 12.0;
  const maxHousing = Math.max(backEndDti * monthlyIncome - monthlyDebts, 0);

  let price = downPayment;
  if (maxHousing > 0 && monthlyIncome > 0 && n > 0) {
    for (let i = 0; i < 6; i++) {
      const loanGuess = Math.max(price - downPayment, 0);
      const ltvGuess = price > 0 ? loanGuess / price : 0;
      const pmi = ltvGuess > 0.80 ? (loanGuess * PMI_ANNUAL_RATE) / 12.0 : 0;
      const tax = (price * (taxRatePct / 100.0)) / 12.0;
      const ins = insuranceYr / 12.0;
      const piBudget = maxHousing - (tax + ins + hoaMonthly + melloRoosMonthly + pmi);
      if (piBudget <= 0) { price = downPayment; break; }
      const loan = M.loanFromPayment(piBudget, r, n);
      price = loan + downPayment;
    }
  }

  const finalLoan = Math.max(price - downPayment, 0);
  const finalLtv = price > 0 ? finalLoan / price : 0;
  const finalPmi = finalLtv > 0.80 ? (finalLoan * PMI_ANNUAL_RATE) / 12.0 : 0;
  const finalTax = (price * (taxRatePct / 100.0)) / 12.0;
  const finalIns = insuranceYr / 12.0;
  const finalPi = finalLoan > 0 ? M.monthlyPI(finalLoan, r, n) : 0;
  const totalMonthly = finalPi + finalTax + finalIns + hoaMonthly + melloRoosMonthly + finalPmi;

  return {
    price, loan: finalLoan, piPayment: finalPi, monthlyTax: finalTax, monthlyInsurance: finalIns,
    monthlyHoa: hoaMonthly, monthlyMello: melloRoosMonthly, monthlyPmi: finalPmi, totalMonthly,
    frontEndDti: monthlyIncome > 0 ? totalMonthly / monthlyIncome : 0,
    backEndDti: monthlyIncome > 0 ? (totalMonthly + monthlyDebts) / monthlyIncome : 0,
    ltv: finalLtv,
    downPaymentPercent: price > 0 ? downPayment / price : 0,
  };
}

function tierToResult(t) {
  return {
    price: M.round2(t.price),
    loan: M.round2(t.loan),
    piPayment: M.round2(t.piPayment),
    monthlyTax: M.round2(t.monthlyTax),
    monthlyInsurance: M.round2(t.monthlyInsurance),
    monthlyHoa: M.round2(t.monthlyHoa),
    monthlyMelloRoos: M.round2(t.monthlyMello),
    monthlyPmi: M.round2(t.monthlyPmi),
    totalMonthly: M.round2(t.totalMonthly),
    frontEndDti: M.round2(t.frontEndDti * 100.0),
    backEndDti: M.round2(t.backEndDti * 100.0),
    ltv: M.round2(t.ltv * 100.0),
    downPaymentPercent: M.round2(t.downPaymentPercent * 100.0),
  };
}

// ---- GET loans/maxloan ----
export function maxLoanEstimator(request, env) {
  const url = new URL(request.url);
  const targetPmt = M.getDouble(url.searchParams.get('targetPmt'));
  const intRatePct = M.getDouble(url.searchParams.get('intRate'));
  const years = M.getDouble(url.searchParams.get('term'));
  const otherCosts = M.getDouble(url.searchParams.get('otherCosts'));

  if (
    !(targetPmt > 0 && M.isSaneAmount(targetPmt)) ||
    !M.isSaneRate(intRatePct) || !M.isSaneTerm(years) || !M.isSaneAmount(otherCosts)
  ) {
    return badRequest(
      `targetPmt must be positive; intRate must be 0-${M.MAX_RATE_PERCENT}%; ` +
      `term must be ${M.MIN_TERM_YEARS}-${M.MAX_TERM_YEARS} years; otherCosts must be zero or positive.`
    );
  }

  const intRate = intRatePct / 100 / 12;
  const months = years * 12;
  const piAvailable = targetPmt - otherCosts;

  let maxLoan = 0;
  if (piAvailable > 0 && intRate > 0) {
    maxLoan = piAvailable * ((1 - Math.pow(1 + intRate, -months)) / intRate);
  } else if (piAvailable > 0 && intRate === 0) {
    maxLoan = piAvailable * months;
  }

  return ok({ maxLoanAmount: maxLoan, piAvailable, taxesAndIns: otherCosts, totalBudget: targetPmt });
}

// ---- GET/POST loans/prepaymentcalculator ----
// No live frontend consumer found for this route (checked wwwroot/js for any call site) — ported
// with clean camelCase output matching every other calculator's convention.
export async function prepaymentCalculator(request, env) {
  const url = new URL(request.url);
  const p = await readParams(request, url, ['loanAmt', 'term', 'paymentsPerTerm', 'rate', 'addlPaymentPerPeriod']);

  const loanAmt = M.getUint(p.loanAmt) ?? 0;
  const term = M.getUint(p.term) ?? 0;
  const paymentsPerTerm = M.getUint(p.paymentsPerTerm) ?? 0;
  const rate = M.getDouble(p.rate, 0);
  const addlPaymentPerPeriod = M.getUint(p.addlPaymentPerPeriod) ?? 0;

  const valid =
    loanAmt > 0 && loanAmt <= M.MAX_DOLLAR_AMOUNT &&
    term > 0 && term <= M.MAX_TERM_YEARS &&
    paymentsPerTerm > 0 && paymentsPerTerm <= M.MAX_PAYMENTS_PER_TERM &&
    rate > 0 && rate <= M.MAX_RATE_PERCENT &&
    addlPaymentPerPeriod <= M.MAX_DOLLAR_AMOUNT;

  // C# returns an empty {} body here (BadRequestObjectResult(emptyJson)), not an error message —
  // preserved as-is even though it's an odd contract, since nothing currently consumes this route.
  if (!valid) return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });

  const prePayment = getRemainingPeriods(loanAmt, term, rate, paymentsPerTerm, addlPaymentPerPeriod);
  return ok({ prePayment });
}

function getRemainingPeriods(principal, term, rate, paymentsPerTerm, addlPaymentPerPeriod) {
  const expectedRemainingPayments = term * paymentsPerTerm;
  const rateBy100TimesPaymentsPerTerm = rate / (100 * paymentsPerTerm);
  const expectedPayment = (principal * rateBy100TimesPaymentsPerTerm) / (1 - Math.pow(1 + rateBy100TimesPaymentsPerTerm, -expectedRemainingPayments));

  const complexLog = 0 - Math.log(1 - (principal * rateBy100TimesPaymentsPerTerm) / (expectedPayment + addlPaymentPerPeriod));
  const logOf1PlusRate = Math.log(1 + rateBy100TimesPaymentsPerTerm);
  const remainingPeriods = complexLog / logOf1PlusRate;

  return { expectedPayment, remainingPeriods: roundHalfEven(remainingPeriods) };
}

// ---- GET/POST loans/reficalculator ----
export async function refiCalculator(request, env) {
  const url = new URL(request.url);
  const p = await readParams(request, url, [
    'originalLoanAmt', 'currentBalance', 'currentRate', 'originalTerm',
    'newLoanAmt', 'newRate', 'newTerm', 'closingCosts',
  ]);

  const originalLoanAmt = M.getDouble(p.originalLoanAmt, 0);
  const currentBalance = M.getDouble(p.currentBalance, 0);
  const currentRate = M.getDouble(p.currentRate, 0);
  const originalTerm = M.getInt(p.originalTerm, 30);
  const newLoanAmt = M.getDouble(p.newLoanAmt, 0);
  const newRate = M.getDouble(p.newRate, 0);
  const newTerm = M.getInt(p.newTerm, 30);
  const closingCosts = M.getDouble(p.closingCosts, 0);

  const errors = [];
  if (!(originalLoanAmt > 0 && M.isSaneAmount(originalLoanAmt))) errors.push('originalLoanAmt must be a positive dollar amount.');
  if (!(currentBalance > 0 && M.isSaneAmount(currentBalance))) errors.push('currentBalance must be a positive dollar amount.');
  if (!(currentRate > 0 && M.isSaneRate(currentRate))) errors.push(`currentRate must be greater than 0 and no more than ${M.MAX_RATE_PERCENT}%.`);
  if (!M.isSaneTerm(originalTerm)) errors.push(`originalTerm must be between ${M.MIN_TERM_YEARS} and ${M.MAX_TERM_YEARS} years.`);
  if (!(newLoanAmt > 0 && M.isSaneAmount(newLoanAmt))) errors.push('newLoanAmt must be a positive dollar amount.');
  if (!(newRate > 0 && M.isSaneRate(newRate))) errors.push(`newRate must be greater than 0 and no more than ${M.MAX_RATE_PERCENT}%.`);
  if (!M.isSaneTerm(newTerm)) errors.push(`newTerm must be between ${M.MIN_TERM_YEARS} and ${M.MAX_TERM_YEARS} years.`);
  if (closingCosts < 0 || !M.isSaneAmount(closingCosts)) errors.push('closingCosts must be zero or a positive dollar amount.');

  if (errors.length > 0) return badRequest(errors.join(' '));

  const monthlyRateCurr = (currentRate / 100) / 12;
  const totalMonthsCurr = originalTerm * 12;
  const currentMonthlyPI = originalLoanAmt * (monthlyRateCurr * Math.pow(1 + monthlyRateCurr, totalMonthsCurr)) / (Math.pow(1 + monthlyRateCurr, totalMonthsCurr) - 1);

  const monthlyRateNew = (newRate / 100) / 12;
  const totalMonthsNew = newTerm * 12;
  const newMonthlyPI = newLoanAmt * (monthlyRateNew * Math.pow(1 + monthlyRateNew, totalMonthsNew)) / (Math.pow(1 + monthlyRateNew, totalMonthsNew) - 1);

  const monthlySavings = currentMonthlyPI - newMonthlyPI;
  const breakEvenMonths = monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : 0;

  // Compare interest over the SAME horizon (the new loan's term), not original vs new term.
  const totalCurrInterest = (currentMonthlyPI * totalMonthsNew) - originalLoanAmt;
  const totalNewInterest = (newMonthlyPI * totalMonthsNew) - newLoanAmt;
  const totalInterestSavings = totalCurrInterest - totalNewInterest;

  return ok({
    currentMonthlyPI: M.round2(currentMonthlyPI),
    newMonthlyPI: M.round2(newMonthlyPI),
    monthlySavings: M.round2(monthlySavings),
    totalCurrInterest: M.round2(totalCurrInterest),
    totalNewInterest: M.round2(totalNewInterest),
    totalInterestSavings: M.round2(totalInterestSavings),
    breakEvenMonths,
  });
}

// ---- GET loans/rentvsbuy ----
export function rentVsBuy(request, env) {
  const url = new URL(request.url);
  const rent = M.getDouble(url.searchParams.get('monthlyRent'));
  const rentIncPct = M.getDouble(url.searchParams.get('rentIncrease'));
  const price = M.getDouble(url.searchParams.get('homePrice'));
  const apprecPct = M.getDouble(url.searchParams.get('appreciation'));
  const downPctRaw = M.getDouble(url.searchParams.get('downPmtPct'));
  const intRatePct = M.getDouble(url.searchParams.get('intRate'));

  if (
    !(rent > 0 && M.isSaneAmount(rent)) || !M.isSaneEconomicPercent(rentIncPct) ||
    !(price > 0 && M.isSaneAmount(price)) || !M.isSaneEconomicPercent(apprecPct) ||
    !M.isSanePercentZeroToHundred(downPctRaw) || !M.isSaneRate(intRatePct)
  ) {
    return badRequest('One or more inputs are out of range (negative/zero rent or price, an unrealistic rent-increase or appreciation assumption, down payment outside 0-100%, or interest rate outside 0-30%).');
  }

  const rentInc = rentIncPct / 100;
  const apprec = apprecPct / 100;
  const downPct = downPctRaw / 100;
  const monthlyRate = intRatePct / 100 / 12;

  const years = 9; // standard industry benchmark
  const term = 30; // assume a 30-year mortgage (this form has no term input)
  const monthsOwned = years * 12;
  const totalPayments = term * 12;

  let totalRent = 0;
  let currentRent = rent;
  for (let i = 0; i < years; i++) {
    totalRent += currentRent * 12;
    currentRent *= 1 + rentInc;
  }

  const futureValue = price * Math.pow(1 + apprec, years);

  const downPayment = price * downPct;
  const loanAmt = price - downPayment;
  const monthlyPIAmt = M.monthlyPI(loanAmt, monthlyRate, totalPayments);

  let balance = loanAmt;
  for (let m = 0; m < monthsOwned && balance > 0; m++) {
    const interest = balance * monthlyRate;
    const principal = monthlyPIAmt - interest;
    balance -= principal;
  }
  const principalPaid = loanAmt - balance;

  const totalBuyCost = downPayment + monthlyPIAmt * monthsOwned;
  const equityGained = downPayment + principalPaid + (futureValue - price);

  return ok({
    totalRentCost: totalRent,
    futureValue,
    equityGained,
    totalBuyCost,
    netBenefit: totalRent + equityGained - totalBuyCost,
  });
}
