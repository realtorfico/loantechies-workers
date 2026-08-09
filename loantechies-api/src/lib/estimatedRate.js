// Port of Loans/EstimatedRateFunction.cs — GET loans/estimatedrate, the core public "What's My
// Rate" pricing endpoint. Combines the LoanFactory/RocketPro/Provident-merged market rate with
// every config-driven adjustment (LLPA/GovAdj credit x LTV delta, CLTV surcharge) plus the
// eligibility rules. Hard-fails (503 + rate-limited alert) if the config is missing/unreadable —
// never falls back to guessed pricing.
import { ok, badRequest, serviceUnavailable } from './http.js';
import { loadAsync as loadRateConfig } from './rateConfigStore.js';
import { evaluateEligibility, computeLlpaDelta, computeGovAdj, computeCltvAdj, computeLadder } from './rateConfig.js';
import { getQuote } from './loanFactoryRatesProvider.js';
import { shouldAlert } from './alertCooldown.js';
import { businessInbox, sendViaResend } from './emailer.js';

const CONFIG_ALERT_COOLDOWN_MINUTES = 60;

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export async function getEstimatedRate(request, env) {
  const url = new URL(request.url);
  const creditLabel = url.searchParams.get('credit');
  const ltvStr = url.searchParams.get('ltv');
  const termStr = url.searchParams.get('term');
  const refinanceStr = url.searchParams.get('refinance');
  const cltvStr = url.searchParams.get('cltv');
  const occupancy = url.searchParams.get('occupancy')?.trim() || 'Primary Residence';
  const loanType = url.searchParams.get('loanType')?.trim() || 'Conventional';

  if (!creditLabel?.trim() || !ltvStr?.trim() || !termStr?.trim())
    return badRequest('Missing required parameters: credit, ltv, term.');

  const ltv = Number(ltvStr);
  if (!Number.isFinite(ltv) || ltv < 0 || ltv > 100) return badRequest('Invalid ltv: must be 0-100.');

  const term = parseInt(termStr, 10);
  if (!Number.isFinite(term)) return badRequest('term must be an integer (e.g. 30, 15, 7, 5).');

  const refinance = (refinanceStr || '').trim().toLowerCase() === 'true';

  // CLTV is optional; defaults to LTV when absent (no second loan). Not upper-bounded — a CLTV
  // above 100% legitimately falls through to the >96.5% ineligibility check.
  let cltv = ltv;
  const parsedCltv = Number(cltvStr);
  if (cltvStr?.trim() && Number.isFinite(parsedCltv) && parsedCltv >= 0) cltv = parsedCltv;

  const cfg = await loadRateConfig(env);
  if (!cfg) {
    const msg = 'Estimated-rate configuration is missing or unreadable from storage. ' +
      'loans/estimatedrate returned 503. ' +
      'Fix: open the admin Rate Settings page (admin.loantechies.com) once to seed defaults, or verify the D1 database.';
    console.error(msg);
    sendConfigAlert('Estimated-rate config missing or unreadable', msg, env); // fire-and-forget
    return serviceUnavailable('Service configuration error.');
  }

  const ineligibleReason = evaluateEligibility(cfg, {
    creditLabel, ltv, cltv, occupancy, loanType, term, refinance,
  });
  if (ineligibleReason != null) return ok({ eligible: false, message: ineligibleReason });

  // "Not sure" -> conservative credit tier for the LLPA/GovAdj lookup, flagged to the UI.
  const isEstimated = creditLabel === 'Not sure';
  const creditForAdj = isEstimated ? '640-659' : creditLabel;

  const llpaDelta = computeLlpaDelta(cfg, creditForAdj, ltv, loanType);
  const govAdj = computeGovAdj(cfg, creditForAdj, ltv, loanType);
  const cltvAdj = computeCltvAdj(cfg, ltv, cltv);
  const creditLtvAdj = llpaDelta + govAdj;

  const quote = await getQuote(loanType, occupancy, term, refinance, cfg, env);
  const rateSource = quote.source;

  const adjustedRate = round4(quote.rate + creditLtvAdj + cltvAdj);
  const aprAvailable = quote.apr != null;
  const adjustedApr = aprAvailable ? round4(quote.apr + creditLtvAdj + cltvAdj) : adjustedRate;
  const marketRate = quote.rate;

  let ladder = null;
  if ((url.searchParams.get('ladder') || '').trim().toLowerCase() === 'true') {
    const rungs = computeLadder(cfg, adjustedRate, adjustedApr, aprAvailable, term, loanType);
    ladder = rungs.map((r) => ({
      rate: r.rate, apr: r.apr, aprApprox: r.aprApprox || undefined, points: r.points, par: r.par || undefined,
    }));
  }

  return ok({
    eligible: true,
    rate: adjustedRate,
    apr: aprAvailable ? adjustedApr : null,
    fallback: rateSource === 'config-fallback' || undefined,
    isEstimated: isEstimated || undefined,
    marketRate: round4(marketRate),
    rateOffset: 0.0, // LoanFactory formula shift is already baked into marketRate — see rateConfig.js doc comment
    llpaDelta: round4(llpaDelta),
    govAdj: round4(govAdj),
    occupancyAdj: 0.0, // occupancy is baked into branch selection, not an additive term
    cltvAdj: round4(cltvAdj),
    rateSource,
    snapshotDate: quote.sourceSnapshotDate, // dated by rateSource's own feed, not necessarily LoanFactory's
    ladder,
  });
}

async function sendConfigAlert(subject, details, env) {
  if (!(await shouldAlert(env, 'estimatedrate-config-missing', CONFIG_ALERT_COOLDOWN_MINUTES))) return;
  const to = businessInbox(env);
  if (!to) { console.error('Cannot send config alert — no business inbox configured.'); return; }
  const body = `[LoanTechies Config Alert]\n\n${details}\n\nSent at: ${new Date().toISOString()}\nThis alert repeats at most once per hour while the issue persists.`;
  await sendViaResend(env, to, `[LoanTechies Alert] ${subject}`, body);
}
