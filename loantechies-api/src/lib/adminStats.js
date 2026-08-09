// Port of Admin/AdminApi.cs's console/stats endpoint (Access-gated dashboard summary). Migrated
// urgently alongside adminLeads.js — same stale-read gap.
import { ok, unauthorized, nowSeconds } from './http.js';
import { requireAccess } from './auth.js';
import { computeStats } from './adminAggregates.js';

export async function getStats(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return unauthorized();

  const [leads, alerts, savingsAlerts, inquiries] = await Promise.all([
    env.DB.prepare('SELECT created_at, verified_at, form_data_json, lang FROM leads WHERE deleted = 0').all(),
    env.DB.prepare('SELECT created_at, active, term, refinance, lang FROM rate_alerts').all(),
    env.DB.prepare('SELECT created_at, active, term, lang FROM savings_alerts').all(),
    env.DB.prepare('SELECT created_at, lang, source FROM inquiries').all(),
  ]);

  return ok(computeStats(leads.results, alerts.results, inquiries.results, savingsAlerts.results, nowSeconds()));
}
