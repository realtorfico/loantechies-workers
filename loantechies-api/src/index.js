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
import { emailRate, unsubscribeLeadEmail } from './lib/leadRateEmail.js';
import { setPreApprovalStatus } from './lib/leadPreApprovalStatus.js';
import { getStats } from './lib/adminStats.js';
import { listLeads, saveLead as adminSaveLead, deleteLead as adminDeleteLead } from './lib/adminLeads.js';
import { listRateAlerts, createRateAlert, listSavingsAlerts, createSavingsAlert } from './lib/adminAlerts.js';
import { listInquiries } from './lib/adminInquiries.js';
import { sendInquiry } from './lib/sendInquiry.js';
import { emailResults } from './lib/emailResults.js';
import { subscribeRateAlert, unsubscribeRateAlert, evaluateAndNotify as evaluateRateAlerts } from './lib/rateAlert.js';
import { subscribeSavingsAlert, unsubscribeSavingsAlert, evaluateAndNotify as evaluateSavingsAlerts } from './lib/savingsAlert.js';
import { checkAndAlertGuardrails } from './lib/zillowCurrentRatesProvider.js';
import { loadAsync as loadRateConfig } from './lib/rateConfigStore.js';
import { run as runIncompleteNoticeAutoWithdraw } from './lib/incompleteNoticeAutoWithdraw.js';
import { getQuestionnairePdf } from './lib/questionnaireFunction.js';
import { uploadDocument } from './lib/documentUploadFunction.js';
import { listUploads, getUploadFileUrl } from './lib/adminDocumentUploads.js';
import { serveDocument } from './lib/documentSign.js';
import { listAzureFallbackHits } from './lib/adminAzureFallback.js';
import { ratesProvider } from './lib/ratesProvider.js';
import { run as runRateSnapshotTimer } from './lib/rateSnapshotTimer.js';
import { run as runLlpaReviewReminder } from './lib/llpaReviewReminder.js';
import { run as runConformingLimitReminder } from './lib/conformingLimitReminder.js';

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

    // ---- Migrated routes (Phase 3: admin lead management — urgent, closes the stale-read gap
    // opened by EstimateGate/RateAlert/SavingsAlert/Inquiry writes moving to D1 above) ----

    if (pathname === '/console/stats' && method === 'GET') return getStats(request, env);
    if (pathname === '/console/leads' && method === 'GET') return listLeads(request, env);
    if (pathname === '/console/leads/save' && method === 'POST') return adminSaveLead(request, env);
    if (pathname === '/console/leads/delete' && method === 'POST') return adminDeleteLead(request, env);
    if (pathname === '/console/leads/email-rate' && method === 'POST') return emailRate(request, env);
    if (pathname === '/console/leads/pre-approval-status' && method === 'POST') return setPreApprovalStatus(request, env);
    if (pathname === '/leads/email/unsubscribe' && (method === 'GET' || method === 'POST')) return unsubscribeLeadEmail(request, env);
    if (pathname === '/console/rate-alerts' && method === 'GET') return listRateAlerts(request, env);
    if (pathname === '/console/rate-alerts/create' && method === 'POST') return createRateAlert(request, env);
    if (pathname === '/console/savings-alerts' && method === 'GET') return listSavingsAlerts(request, env);
    if (pathname === '/console/savings-alerts/create' && method === 'POST') return createSavingsAlert(request, env);
    if (pathname === '/console/inquiries' && method === 'GET') return listInquiries(request, env);

    // ---- Migrated route: questionnaire PDF (cover page + fillable base form) ----
    if (pathname === '/loans/questionnaire' && method === 'GET') return getQuestionnairePdf(request, env);

    // ---- Phase 4: document uploads to R2 ----
    if (pathname === '/loans/documentupload' && method === 'POST') return uploadDocument(request, env);
    if (pathname === '/console/uploads' && method === 'GET') return listUploads(request, env);
    if (pathname === '/console/uploads/file-url' && method === 'GET') return getUploadFileUrl(request, env);
    if (pathname === '/documents' && method === 'GET') return serveDocument(request, env);

    // ---- Phase 6 prep: visibility into what's still hitting the Azure fallback ----
    if (pathname === '/console/azure-fallback' && method === 'GET') return listAzureFallbackHits(request, env);

    // ---- Phase 6: last unported HTTP route (historical rate-chart data) ----
    if (pathname === '/loans/ratesprovider' && (method === 'GET' || method === 'POST')) return ratesProvider(request, env);

    return forwardToAzure(request, env, ctx);
  },

  // Three independent cron schedules dispatched by event.cron — see wrangler.jsonc's triggers.crons.
  async scheduled(event, env, ctx) {
    if (event.cron === '0 15 * * *') {
      // Daily, ~8am Pacific — two unrelated C# timers happened to share this UTC slot, so they
      // still run back-to-back here: Config/IncompleteNoticeAutoWithdraw.cs's Reg B §1002.9(c)
      // sweep, then Loans/RateSnapshotTimer.cs's daily rate-history snapshot.
      await runIncompleteNoticeAutoWithdraw(env);
      await runRateSnapshotTimer(env);
      return;
    }
    if (event.cron === '0 9 * * *') {
      // Daily @ 9am UTC, internally date-gated to also cover the monthly (LlpaReviewReminder,
      // 1st of the month) and yearly (ConformingLimitReminder, Dec 1) C# timers on ONE Cloudflare
      // trigger slot instead of two. Workers Free caps at 5 cron triggers per ACCOUNT (not per
      // Worker) — this account already runs other cron Workers (the keepalive pinger, the news
      // aggregator), so minimizing trigger count here matters more than it would in isolation;
      // see memory/commit history for the account hitting that cap with the original 1-slot-per-
      // schedule design.
      const now = new Date();
      const day = now.getUTCDate();
      const month = now.getUTCMonth() + 1; // 1-12
      if (day === 1) await runLlpaReviewReminder(env);
      if (month === 12 && day === 1) await runConformingLimitReminder(env);
      return;
    }

    // Port of KeepAliveWarmer.cs's 5-min pulse — but only the parts that still apply. The C#
    // version also warms RatesProvider's historical-chart cache and pre-fetches 4 Zillow
    // getCurrentRates bucket combos; neither is replicated here: ratesProvider.js and
    // zillowCurrentRatesProvider.js both deliberately dropped the C#'s stale-while-revalidate
    // caching in favor of a plain per-isolate TTL cache (see each module's own doc comment) — so
    // there is nothing to pre-warm for either anymore.
    const cfg = await loadRateConfig(env);
    if (cfg) checkAndAlertGuardrails(cfg, env); // fire-and-forget, matches the C#'s own contract

    await evaluateRateAlerts(env);
    await evaluateSavingsAlerts(env);
  },
};
