// Port of Loans/RatesCurrentFunction.cs — GET loans/rates/current, a public diagnostic endpoint.
// No frontend consumer found (per the C#'s own doc comment) — safe to preserve the shape exactly.
import { ok, toIso } from './http.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';
import { getQuote } from './loanFactoryRatesProvider.js';
import { getLatest as getLatestPmms } from './pmmsProvider.js';

const COMBOS = [
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 30, refinance: false, key: 'conventionalPrimaryPurchase30' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 30, refinance: true, key: 'conventionalPrimaryRefinance30' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 15, refinance: false, key: 'conventionalPrimaryPurchase15' },
  { loanType: 'Conventional', occupancy: 'Primary Residence', term: 15, refinance: true, key: 'conventionalPrimaryRefinance15' },
  { loanType: 'Conventional', occupancy: 'Investment Property', term: 30, refinance: false, key: 'conventionalInvestmentPurchase30' },
  { loanType: 'Conventional', occupancy: 'Investment Property', term: 30, refinance: true, key: 'conventionalInvestmentRefinance30' },
  { loanType: 'Conventional', occupancy: 'Second Home', term: 30, refinance: false, key: 'conventionalSecondHomePurchase30' },
  { loanType: 'Conventional', occupancy: 'Second Home', term: 30, refinance: true, key: 'conventionalSecondHomeRefinance30' },
  { loanType: 'FHA', occupancy: 'Primary Residence', term: 30, refinance: false, key: 'fhaPrimaryPurchase30' },
  { loanType: 'VA', occupancy: 'Primary Residence', term: 30, refinance: false, key: 'vaPrimaryPurchase30' },
];

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export async function getRatesCurrent(request, env) {
  const cfg = await loadRateConfig(env);
  const pmmsPromise = getLatestPmms(env);

  const quotes = {};
  for (const c of COMBOS) {
    const q = cfg ? await getQuote(c.loanType, c.occupancy, c.term, c.refinance, cfg, env) : null;
    quotes[c.key] = q == null ? null : {
      rate: round4(q.rate),
      apr: q.apr != null ? round4(q.apr) : null,
      available: q.available,
      source: q.source,
      snapshotDate: q.snapshotDate,
    };
  }

  const { rates: pmms } = await pmmsPromise;

  return ok({
    asOfUtc: toIso(Math.floor(Date.now() / 1000)),
    rateSource: 'loanfactory',
    rates: quotes,
    pmms: {
      yr30: pmms?.[30] > 0 ? pmms[30] : null,
      yr15: pmms?.[15] > 0 ? pmms[15] : null,
      note: 'Weekly Freddie Mac average (30+15yr fixed only, no ARMs). Lags market by ~1 week.',
    },
    fallbackRates: cfg ? { yr30: cfg.fallbackRate30, yr15: cfg.fallbackRate15 } : null,
  });
}
