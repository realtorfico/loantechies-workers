// Port of Config/RateConfig.cs's RateConfigStore — persistence for the admin-editable
// estimated-rate config, now on D1's app_config (key "estimated-rate") + rate_config_history
// tables instead of Azure Table Storage. No in-memory TTL cache (unlike the C#'s 60s cache) — D1
// reads are cheap enough that the cache was purely an Azure-Table-latency mitigation, same
// reasoning as every other Phase 1 config store.
import {
  defaults, ensureFallbackDefaults, ensurePricingCurve, ensureRefiGuardrails,
  ensureLoanFactoryDefaults, ensureEligibilityRules, ensureLtvColumnMigration,
} from './rateConfig.js';
import { nowSeconds } from './http.js';

const KEY = 'estimated-rate';

function heal(cfg) {
  if (!cfg) return cfg;
  ensureFallbackDefaults(cfg);
  ensurePricingCurve(cfg);
  ensureRefiGuardrails(cfg);
  ensureLoanFactoryDefaults(cfg);
  ensureEligibilityRules(cfg);
  ensureLtvColumnMigration(cfg);
  return cfg;
}

// Cached config for the hot estimate path. Returns null when the config row is missing or
// unreadable — the caller hard-fails (503 + alert) rather than guessing prices.
export async function loadAsync(env) {
  try {
    const row = await env.DB.prepare('SELECT json FROM app_config WHERE key = ?').bind(KEY).first();
    if (!row || !row.json) return null;
    const cfg = JSON.parse(row.json);
    return cfg ? heal(cfg) : null;
  } catch (e) {
    console.error(`rateConfigStore.loadAsync failed — ${e.message}`);
    return null;
  }
}

// Read for the admin GET; seeds defaults when the row doesn't exist yet, so a single admin page
// visit makes the estimate endpoint live.
export async function readOrSeedAsync(env, seededBy) {
  const row = await env.DB.prepare('SELECT json, version, updated_at, updated_by FROM app_config WHERE key = ?').bind(KEY).first();
  if (row && row.json) {
    return {
      config: heal(JSON.parse(row.json)),
      version: row.version,
      updatedUtc: row.updated_at,
      updatedBy: row.updated_by,
      seeded: false,
    };
  }

  const dflt = defaults();
  const now = nowSeconds();
  const updatedBy = seededBy || 'system (seed)';
  await env.DB.prepare(
    'INSERT INTO app_config (key, json, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)'
  ).bind(KEY, JSON.stringify(dflt), now, updatedBy).run();
  await writeHistory(env, dflt, 1, now, updatedBy);
  return { config: dflt, version: 1, updatedUtc: now, updatedBy, seeded: true };
}

// Persists a validated config. Optimistic concurrency on the integer version: the caller passes
// the version it loaded; a mismatch returns { status: 'conflict' }.
export async function saveAsync(env, dto, updatedBy, expectedVersion) {
  try {
    const row = await env.DB.prepare('SELECT version FROM app_config WHERE key = ?').bind(KEY).first();
    const now = nowSeconds();

    if (!row) {
      await env.DB.prepare(
        'INSERT INTO app_config (key, json, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)'
      ).bind(KEY, JSON.stringify(dto), now, updatedBy).run();
      await writeHistory(env, dto, 1, now, updatedBy);
      return { status: 'ok', version: 1, updatedUtc: now, updatedBy };
    }

    if (row.version !== expectedVersion) return { status: 'conflict', currentVersion: row.version };

    const newVersion = expectedVersion + 1;
    await env.DB.prepare(
      'UPDATE app_config SET json = ?, version = ?, updated_at = ?, updated_by = ? WHERE key = ?'
    ).bind(JSON.stringify(dto), newVersion, now, updatedBy, KEY).run();
    await writeHistory(env, dto, newVersion, now, updatedBy);
    return { status: 'ok', version: newVersion, updatedUtc: now, updatedBy };
  } catch (e) {
    console.error(`rateConfigStore.saveAsync failed — ${e.message}`);
    return { status: 'error' };
  }
}

// Append (or replace, on a retry) the value-trail row for a saved version. Best-effort — a
// history-write failure is logged but never fails the underlying config save. Stores the FULL
// config snapshot as JSON rather than mirroring specific scalar columns (the C# tracked 4 fixed
// fields in dedicated columns) — this D1 table is new, so there's no reason to bake in the same
// fixed-column limitation; the history read below picks out whichever fields are useful.
async function writeHistory(env, dto, version, updatedAt, updatedBy) {
  try {
    await env.DB.prepare(
      `INSERT INTO rate_config_history (version, json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(version, JSON.stringify(dto), updatedAt, updatedBy || '').run();
  } catch (e) {
    console.warn(`rateConfigStore history write failed (v${version}): ${e.message}`);
  }
}

// The full value trail, newest version first. Empty on any read failure.
export async function readHistoryAsync(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT version, json, updated_at, updated_by FROM rate_config_history ORDER BY version DESC'
    ).all();
    return (results || []).map((r) => ({
      version: r.version,
      config: r.json ? JSON.parse(r.json) : null,
      updatedUtc: r.updated_at,
      updatedBy: r.updated_by,
    }));
  } catch (e) {
    console.warn(`rateConfigStore.readHistoryAsync failed — ${e.message}`);
    return [];
  }
}
