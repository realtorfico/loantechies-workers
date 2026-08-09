// Generic D1-backed key/value store replacing Azure Table "AppConfig" (PK "config", one JSON blob
// per RowKey). Every admin config store (visitExclusions, featureFlags, questionnaireConfig,
// estimateDefaults, contactConfig) is a thin wrapper around this — same shared-ConfigEntity pattern
// SofticianApi's C# side uses (Config/RateConfig.cs's ConfigEntity, reused by every Config/*.cs
// store). No in-memory cache here (unlike the C#'s 60s TTL cache) — D1 reads are cheap enough that
// the cache was purely an Azure-Table-latency mitigation, not a correctness requirement.
import { nowSeconds } from './http.js';

export async function loadConfigJson(env, key) {
  const row = await env.DB.prepare('SELECT json FROM app_config WHERE key = ?').bind(key).first();
  if (!row || !row.json) return null;
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

export async function saveConfigJson(env, key, value, updatedBy) {
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO app_config (key, json, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       json = excluded.json,
       version = app_config.version + 1,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).bind(key, JSON.stringify(value), now, updatedBy || null).run();
}
