// loantechies-api — Cloudflare Worker backend for loantechies.com / admin.loantechies.com,
// migrating off SofticianApi (Azure Functions) one route at a time. See wrangler.jsonc for
// bindings/deploy notes and the migration plan for phasing.
//
// Router shape mirrors examprep-api/src/index.js: a flat if(pathname && method) chain. Every
// migrated route gets an explicit branch ABOVE the forwardToAzure() fallback at the bottom —
// anything without a branch here transparently rides on Azure until it's ported.
import { forwardToAzure } from './lib/azureForward.js';
import { getContactConfig, saveContactConfig } from './lib/contactConfig.js';
import { getFeatureFlags, saveFeatureFlags } from './lib/featureFlags.js';
import { getQuestionnaireConfig, saveQuestionnaireConfig } from './lib/questionnaireConfig.js';
import {
  getEstimateDefaults, getEstimateDefaultsConsole, saveEstimateDefaults,
} from './lib/estimateDefaults.js';
import { getVisitExclusions, saveVisitExclusions } from './lib/visitExclusions.js';
import { trackVisit, listVisits } from './lib/visits.js';
import {
  ingestLoanFactory, getLoanFactorySnapshots, getLoanFactoryLatest,
  ingestProvident, getProvidentSnapshots, getProvidentAdvertised,
} from './lib/externalRates.js';
import {
  amortizationCalculator, affordabilityCalculator, dtiCalculator, affordabilityEstimator,
  maxLoanEstimator, prepaymentCalculator, refiCalculator, rentVsBuy,
} from './lib/calculators.js';
import { getEstimatedRate } from './lib/estimatedRate.js';
import { getRatesCurrent } from './lib/ratesCurrentFunction.js';
import {
  getRateConfig, getRateConfigDefaults, saveRateConfig, getRateConfigHistory,
  getRateConfigBaseRates, previewRateConfig,
} from './lib/rateConfigAdmin.js';
import {
  requestOtp, verifyOtp, saveLead, esignRequestCode, esignConfirmCode,
  verifyEmployerAddress, status as estimateStatus, quickStart,
} from './lib/estimateGate.js';
import { sendInquiry } from './lib/sendInquiry.js';
import { emailResults } from './lib/emailResults.js';
import { subscribeRateAlert, unsubscribeRateAlert, evaluateAndNotify as evaluateRateAlerts } from './lib/rateAlert.js';
import { subscribeSavingsAlert, unsubscribeSavingsAlert, evaluateAndNotify as evaluateSavingsAlerts } from './lib/savingsAlert.js';
import { checkAndAlertGuardrails } from './lib/zillowCurrentRatesProvider.js';
import { loadAsync as loadRateConfig } from './lib/rateConfigStore.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Native health check — proves the Worker itself deployed and is reachable, independent of
    // whatever fraction of routes still forward to Azure. Not the same thing as SofticianApi's
    // /api/health (which only proves the Azure host is alive); see the Phase 0+ daily
    // secret-presence health check (still to be added) for that concern's Cloudflare-side
    // equivalent.
    if (pathname === '/health' && method === 'GET') {
      return new Response(JSON.stringify({ ok: true, service: 'loantechies-api' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // ---- Migrated routes (Phase 1: config stores, visits, external rates) ----

    if (pathname === '/site/contact-config' && method === 'GET') return getContactConfig(request, env);
    if (pathname === '/console/contact-config/save' && method === 'POST') return saveContactConfig(request, env);

    if (pathname === '/site/feature-flags' && method === 'GET') return getFeatureFlags(request, env);
    if (pathname === '/console/feature-flags/save' && method === 'POST') return saveFeatureFlags(request, env);

    if (pathname === '/console/questionnaire-config' && method === 'GET') return getQuestionnaireConfig(request, env);
    if (pathname === '/console/questionnaire-config/save' && method === 'POST') return saveQuestionnaireConfig(request, env);

    if (pathname === '/site/estimate-defaults' && method === 'GET') return getEstimateDefaults(request, env);
    if (pathname === '/console/estimate-defaults' && method === 'GET') return getEstimateDefaultsConsole(request, env);
    if (pathname === '/console/estimate-defaults/save' && method === 'POST') return saveEstimateDefaults(request, env);

    if (pathname === '/console/visit-exclusions' && method === 'GET') return getVisitExclusions(request, env);
    if (pathname === '/console/visit-exclusions/save' && method === 'POST') return saveVisitExclusions(request, env);

    if (pathname === '/visits/track' && method === 'POST') return trackVisit(request, env);
    if (pathname === '/console/visits' && method === 'GET') return listVisits(request, env);

    if (pathname === '/console/rates/loanfactory/ingest' && method === 'POST') return ingestLoanFactory(request, env);
    if (pathname === '/console/rates/loanfactory' && method === 'GET') return getLoanFactorySnapshots(request, env);
    if (pathname === '/rates/loanfactory/latest' && method === 'GET') return getLoanFactoryLatest(request, env);
    if (pathname === '/console/rates/provident/ingest' && method === 'POST') return ingestProvident(request, env);
    if (pathname === '/console/rates/provident' && method === 'GET') return getProvidentSnapshots(request, env);
    if (pathname === '/console/rates/provident/advertised' && method === 'GET') return getProvidentAdvertised(request, env);

    // ---- Migrated routes (Phase 2: calculators) ----

    if (pathname === '/loans/amortizationcalculator' && (method === 'GET' || method === 'POST')) return amortizationCalculator(request, env);
    if (pathname === '/loans/getloanamount' && (method === 'GET' || method === 'POST')) return affordabilityCalculator(request, env);
    if (pathname === '/loans/dticalculator' && method === 'GET') return dtiCalculator(request, env);
    if (pathname === '/loans/affordability' && method === 'GET') return affordabilityEstimator(request, env);
    if (pathname === '/loans/maxloan' && method === 'GET') return maxLoanEstimator(request, env);
    if (pathname === '/loans/prepaymentcalculator' && (method === 'GET' || method === 'POST')) return prepaymentCalculator(request, env);
    if (pathname === '/loans/reficalculator' && (method === 'GET' || method === 'POST')) return refiCalculator(request, env);
    if (pathname === '/loans/rentvsbuy' && method === 'GET') return rentVsBuy(request, env);

    // ---- Migrated routes (Phase 2: pricing engine — estimate + rate config admin) ----
    // Read (loans/estimatedrate, loans/rates/current) and write (console/rate-config*) sides
    // migrated together in the same push — splitting them would let admin edits silently stop
    // taking effect (write to Azure, read from D1).

    if (pathname === '/loans/estimatedrate' && method === 'GET') return getEstimatedRate(request, env);
    if (pathname === '/loans/rates/current' && method === 'GET') return getRatesCurrent(request, env);
    if (pathname === '/console/rate-config' && method === 'GET') return getRateConfig(request, env);
    if (pathname === '/console/rate-config/defaults' && method === 'GET') return getRateConfigDefaults(request, env);
    if (pathname === '/console/rate-config/save' && method === 'POST') return saveRateConfig(request, env);
    if (pathname === '/console/rate-config/history' && method === 'GET') return getRateConfigHistory(request, env);
    if (pathname === '/console/rate-config/base-rates' && method === 'GET') return getRateConfigBaseRates(request, env);
    if (pathname === '/console/rate-config/preview' && method === 'POST') return previewRateConfig(request, env);

    // ---- Migrated routes (Phase 3: inquiries + rate/savings alerts) ----

    if (pathname === '/utils/sendinquiry' && method === 'POST') return sendInquiry(request, env);
    if (pathname === '/utils/emailresults' && method === 'POST') return emailResults(request, env);
    if (pathname === '/loans/ratealert' && method === 'POST') return subscribeRateAlert(request, env);
    if (pathname === '/loans/ratealert/unsubscribe' && method === 'GET') return unsubscribeRateAlert(request, env);
    if (pathname === '/loans/savingsalert' && method === 'POST') return subscribeSavingsAlert(request, env);
    if (pathname === '/loans/savingsalert/unsubscribe' && method === 'GET') return unsubscribeSavingsAlert(request, env);

    // ---- Migrated routes (Phase 3: EstimateGate — email 2FA, E-SIGN, pre-approval save) ----
    // leads/estimate/status's document list depends on document_uploads, which doesn't migrate
    // until Phase 4 — see estimateGate.js's status() comment.

    if (pathname === '/leads/estimate/request-otp' && method === 'POST') return requestOtp(request, env);
    if (pathname === '/leads/estimate/verify' && method === 'POST') return verifyOtp(request, env);
    if (pathname === '/leads/estimate/save' && method === 'POST') return saveLead(request, env);
    if (pathname === '/leads/estimate/esign/request-code' && method === 'POST') return esignRequestCode(request, env);
    if (pathname === '/leads/estimate/esign/confirm-code' && method === 'POST') return esignConfirmCode(request, env);
    if (pathname === '/leads/estimate/verify-employer-address' && method === 'POST') return verifyEmployerAddress(request, env);
    if (pathname === '/leads/estimate/status' && method === 'POST') return estimateStatus(request, env);
    if (pathname === '/leads/estimate/quick-start' && method === 'POST') return quickStart(request, env);

    return forwardToAzure(request, env);
  },

  // Port of KeepAliveWarmer.cs's 5-min pulse — but only the parts that still apply. The C#
  // version also warms RatesProvider's historical-chart cache and pre-fetches 4 Zillow
  // getCurrentRates bucket combos; neither is replicated here: the historical loans/ratesprovider
  // route hasn't migrated yet (still Azure-forwarded), and zillowCurrentRatesProvider.js
  // deliberately dropped stale-while-revalidate caching in favor of fetch-fresh-on-demand (see
  // that module's doc comment) — so there is nothing to pre-warm for it anymore.
  async scheduled(event, env, ctx) {
    const cfg = await loadRateConfig(env);
    if (cfg) checkAndAlertGuardrails(cfg, env); // fire-and-forget, matches the C#'s own contract

    await evaluateRateAlerts(env);
    await evaluateSavingsAlerts(env);
  },
};
