// Port of Admin/AdminModels.cs's AdminAggregates — pure, unit-testable aggregation + projection
// helpers (no I/O). Operates on raw D1 rows (snake_case columns, epoch-second timestamps) rather
// than the C#'s ITableEntity objects — same translation convention used across every other port
// in this migration.

function inc(d, key) {
  const k = key && String(key).trim() ? String(key).trim() : 'unknown';
  d[k] = (d[k] || 0) + 1;
}

// Loan program from a lead's stored form_data_json, or "unknown" on any parse failure.
export function loanTypeOf(formDataJson) {
  if (!formDataJson || !String(formDataJson).trim()) return 'unknown';
  try {
    const lt = JSON.parse(formDataJson)?.loanType;
    return lt && String(lt).trim() ? lt : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Loan purpose for the leads list: the CRM value if set, else the tool-captured form value, else
// "" (mirrors the admin UI's leadPurposeOf so the column is sortable).
export function purposeOf(crmJson, formDataJson) {
  for (const json of [crmJson, formDataJson]) {
    if (!json || !String(json).trim()) continue;
    try {
      const p = JSON.parse(json)?.purpose;
      if (p && String(p).trim()) return p;
    } catch {
      /* ignore malformed blob, try the next */
    }
  }
  return '';
}

// leads/alerts/inquiries/savingsAlerts are arrays of raw D1 rows; nowEpoch is epoch seconds.
export function computeStats(leads, alerts, inquiries, savingsAlerts, nowEpoch) {
  const d7 = nowEpoch - 7 * 86400;
  const d30 = nowEpoch - 30 * 86400;

  const ls = { total: 0, last7: 0, last30: 0, verified: 0, withFormData: 0, byLang: {}, byLoanType: {} };
  for (const l of leads || []) {
    ls.total++;
    if (l.created_at >= d7) ls.last7++;
    if (l.created_at >= d30) ls.last30++;
    if (l.verified_at != null) ls.verified++;
    if (l.form_data_json && String(l.form_data_json).trim()) ls.withFormData++;
    inc(ls.byLang, l.lang);
    inc(ls.byLoanType, loanTypeOf(l.form_data_json));
  }

  const a = { total: 0, active: 0, last7: 0, last30: 0, purchaseCount: 0, refinanceCount: 0, byTerm: {}, byLang: {} };
  for (const x of alerts || []) {
    a.total++;
    if (x.active) a.active++;
    if (x.created_at >= d7) a.last7++;
    if (x.created_at >= d30) a.last30++;
    if (x.refinance) a.refinanceCount++; else a.purchaseCount++;
    inc(a.byTerm, String(x.term));
    inc(a.byLang, x.lang);
  }

  const sa = { total: 0, active: 0, last7: 0, last30: 0, byProgram: {}, byLang: {} };
  for (const x of savingsAlerts || []) {
    sa.total++;
    if (x.active) sa.active++;
    if (x.created_at >= d7) sa.last7++;
    if (x.created_at >= d30) sa.last30++;
    inc(sa.byProgram, String(x.term));
    inc(sa.byLang, x.lang);
  }

  const iq = { total: 0, last7: 0, last30: 0, byLang: {}, bySource: {} };
  for (const x of inquiries || []) {
    iq.total++;
    if (x.created_at >= d7) iq.last7++;
    if (x.created_at >= d30) iq.last30++;
    inc(iq.byLang, x.lang);
    inc(iq.bySource, x.source);
  }

  return { leads: ls, alerts: a, savingsAlerts: sa, inquiries: iq };
}
