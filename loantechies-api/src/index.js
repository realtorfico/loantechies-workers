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
  ingestProvident, getProvidentSnapshots,
} from './lib/externalRates.js';
import {
  amortizationCalculator, affordabilityCalculator, dtiCalculator, affordabilityEstimator,
  maxLoanEstimator, prepaymentCalculator, refiCalculator, rentVsBuy,
} from './lib/calculators.js';

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
    // console/rates/provident/advertised stays on Azure — needs ProvidentPricing/RegZApr, ported
    // later in Phase 2 alongside the rate-provider fetch chain.

    // ---- Migrated routes (Phase 2: calculators) ----

    if (pathname === '/loans/amortizationcalculator' && (method === 'GET' || method === 'POST')) return amortizationCalculator(request, env);
    if (pathname === '/loans/getloanamount' && (method === 'GET' || method === 'POST')) return affordabilityCalculator(request, env);
    if (pathname === '/loans/dticalculator' && method === 'GET') return dtiCalculator(request, env);
    if (pathname === '/loans/affordability' && method === 'GET') return affordabilityEstimator(request, env);
    if (pathname === '/loans/maxloan' && method === 'GET') return maxLoanEstimator(request, env);
    if (pathname === '/loans/prepaymentcalculator' && (method === 'GET' || method === 'POST')) return prepaymentCalculator(request, env);
    if (pathname === '/loans/reficalculator' && (method === 'GET' || method === 'POST')) return refiCalculator(request, env);
    if (pathname === '/loans/rentvsbuy' && method === 'GET') return rentVsBuy(request, env);

    return forwardToAzure(request, env);
  },

  // Cron dispatch is added once the first timer-triggered route migrates (Phase 3+) — see
  // wrangler.jsonc's commented-out "triggers" block and the migration plan's cron mapping table.
};
