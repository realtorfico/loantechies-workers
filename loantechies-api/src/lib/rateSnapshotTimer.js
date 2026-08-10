// Port of Loans/RateSnapshotTimer.cs — daily (15:00 UTC / ~8am PT) snapshot of conventional
// purchase rates (VeryHigh credit + Normal LTV bucket) into `rate_snapshots`, for historical
// tracking. Retains 365 days; prunes anything older. Skipped (not an error) when Zillow is
// unavailable. Same cron slot as incompleteNoticeAutoWithdraw.js — index.js's scheduled() runs
// both on the 0 15 * * * trigger.
import { nowSeconds } from './http.js';
import { getAllRates, indexKey } from './zillowCurrentRatesProvider.js';

const RETENTION_DAYS = 365;

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // "yyyy-MM-dd"
}

export async function run(env) {
  const today = todayUtc();

  const allRates = await getAllRates('VeryHigh', 'Normal', env);
  if (!allRates) {
    console.warn(`RateSnapshotTimer: no Zillow rates available — skipping snapshot for ${today}.`);
    return;
  }

  const rateAt = (idx) => (allRates[idx] && allRates[idx].rate > 0 ? allRates[idx].rate : null);
  const thirtyYearFixed = rateAt(indexKey(30, false));
  const fifteenYearFixed = rateAt(indexKey(15, false));
  const sevenYearArm = rateAt(indexKey(7, false));
  const fiveYearArm = rateAt(indexKey(5, false));

  try {
    await env.DB.prepare(
      `INSERT INTO rate_snapshots (id, thirty_year_fixed, fifteen_year_fixed, seven_year_arm, five_year_arm, fetched_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'zillow-current')
       ON CONFLICT(id) DO UPDATE SET
         thirty_year_fixed=excluded.thirty_year_fixed, fifteen_year_fixed=excluded.fifteen_year_fixed,
         seven_year_arm=excluded.seven_year_arm, five_year_arm=excluded.five_year_arm,
         fetched_at=excluded.fetched_at, source=excluded.source`
    ).bind(today, thirtyYearFixed, fifteenYearFixed, sevenYearArm, fiveYearArm, nowSeconds()).run();
    console.log(`RateSnapshotTimer: saved ${today} — 30yr=${thirtyYearFixed}, 15yr=${fifteenYearFixed}, 7arm=${sevenYearArm}, 5arm=${fiveYearArm}.`);
  } catch (e) {
    console.error(`RateSnapshotTimer: save failed for ${today} — ${e.message}`);
    return;
  }

  await pruneOldSnapshots(env);
}

async function pruneOldSnapshots(env) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  try {
    const result = await env.DB.prepare('DELETE FROM rate_snapshots WHERE id < ?').bind(cutoff).run();
    const pruned = result?.meta?.changes || 0;
    if (pruned > 0) console.log(`RateSnapshotTimer: pruned ${pruned} snapshot(s) older than ${cutoff}.`);
  } catch (e) {
    console.warn(`RateSnapshotTimer: prune failed — ${e.message}`);
  }
}
