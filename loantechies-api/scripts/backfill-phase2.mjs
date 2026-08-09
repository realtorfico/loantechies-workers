#!/usr/bin/env node
// One-off backfill: Azure Table Storage -> D1, for the Phase 2 pricing-engine config
// ("estimated-rate" app_config key + its value-trail history). This is CRITICAL to run before
// loans/estimatedrate or console/rate-config get any real traffic: without it, the first request
// will SEED FACTORY DEFAULTS into D1 (rateConfigStore.readOrSeedAsync's seed-on-missing behavior,
// same as the C#'s RateConfigStore.ReadOrSeedAsync) — silently overwriting the real, admin-tuned
// LLPA matrix / pricing curve / eligibility rules with placeholder values and mispricing every
// borrower until someone notices.
//
// Like the Phase 1 script, the Azure Json blob is Newtonsoft's PascalCase serialization — this
// transforms it to the camelCase shape rateConfig.js expects (and drops the fields Phase 2
// deliberately doesn't port — see rateConfig.js's module doc comment: RateOffset*, FallbackRate7/5,
// OccupancyAdj/OccupancyAdjMatrix, the ARM guardrail bands. Any field this transform misses or gets
// wrong is self-healed on the next read anyway — rateConfigStore.loadAsync runs the same
// ensureFallbackDefaults/ensurePricingCurve/etc. healing functions the C# always ran on load).
//
// Setup: cd Workers/loantechies-api/scripts && npm install (shares deps with backfill-phase1.mjs)
//
// Required env vars: same 4 as backfill-phase1.mjs (AZURE_STORAGE_CONNECTION_STRING,
// CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN)
//
// Usage:
//   node backfill-phase2.mjs --dry-run   # print what would be written, touch nothing
//   node backfill-phase2.mjs             # actually write
//   node backfill-phase2.mjs --only=config    # just the current config (skip history)
//   node backfill-phase2.mjs --only=history   # just the value trail
import { TableClient } from '@azure/data-tables';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1];

const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!AZURE_CONN) fail('AZURE_STORAGE_CONNECTION_STRING is not set.');
if (!DRY_RUN && (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN))
  fail('CF_ACCOUNT_ID, CF_D1_DATABASE_ID, and CF_API_TOKEN are required unless --dry-run.');

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

async function d1Exec(sql, params) {
  if (DRY_RUN) {
    console.log('[dry-run]', sql, JSON.stringify(params));
    return;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`D1 write failed: ${res.status} ${JSON.stringify(data.errors || data)}`);
  }
}

function toEpoch(v, label) {
  if (v == null) return Math.floor(Date.now() / 1000);
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  console.warn(`  ! could not parse timestamp for ${label}: ${JSON.stringify(v)} — using now`);
  return Math.floor(Date.now() / 1000);
}

function tableClient(tableName) {
  return TableClient.fromConnectionString(AZURE_CONN, tableName, { allowInsecureConnection: false });
}

// --- PascalCase (Azure/Newtonsoft) -> camelCase (rateConfig.js) transform ------------------------

function transformCurve(c) {
  if (!c) return undefined;
  return {
    costPointsPerQuarter: c.CostPointsPerQuarter,
    creditPointsPerQuarter: c.CreditPointsPerQuarter,
    stepPct: c.StepPct,
    stepsEachWay: c.StepsEachWay,
  };
}

function transformRateConfig(raw) {
  const llpa = {};
  for (const [tier, arr] of Object.entries(raw.Llpa || {})) llpa[tier] = arr;
  const govAdj = {};
  for (const [tier, arr] of Object.entries(raw.GovAdj || {})) govAdj[tier] = arr;

  let pricingCurveOverrides;
  if (raw.PricingCurveOverrides) {
    pricingCurveOverrides = {};
    for (const [loanType, curve] of Object.entries(raw.PricingCurveOverrides)) {
      if (curve) pricingCurveOverrides[loanType] = transformCurve(curve);
    }
  }

  return {
    anchorCreditScore: raw.AnchorCreditScore ?? 759,
    anchorLtv: raw.AnchorLtv ?? 80.0,
    deltaRefi30AddOn: raw.DeltaRefi30AddOn ?? 0.2,
    deltaInvSecondHomeRefi30AddOn: raw.DeltaInvSecondHomeRefi30AddOn ?? 0.25,
    deltaPurchase15AddOn: raw.DeltaPurchase15AddOn ?? -0.5,
    deltaRefi15AddOn: raw.DeltaRefi15AddOn ?? -0.5,
    fallbackRate30: raw.FallbackRate30,
    fallbackRate15: raw.FallbackRate15,
    llpa,
    govAdj,
    cltvSurcharge: {
      amount: raw.CltvSurcharge?.Amount ?? 0,
      minFirstLienLtv: raw.CltvSurcharge?.MinFirstLienLtv ?? 0,
    },
    pricingCurve: transformCurve(raw.PricingCurve),
    pricingCurveOverrides,
    eligibilityRules: (raw.EligibilityRules || []).map((r) => ({
      id: r.Id,
      enabled: r.Enabled,
      message: r.Message,
      conditions: (r.Conditions || []).map((c) => ({ field: c.Field, op: c.Op, value: c.Value })),
    })),
    // Arm7/Arm5 bands deliberately dropped — see rateConfig.js's module doc comment.
    refiGuardrails: raw.RefiGuardrails
      ? {
          version: raw.RefiGuardrails.Version,
          yr15: raw.RefiGuardrails.Yr15
            ? {
                vsPurchaseMin: raw.RefiGuardrails.Yr15.VsPurchaseMin,
                vsPurchaseMax: raw.RefiGuardrails.Yr15.VsPurchaseMax,
                vs30yrMin: raw.RefiGuardrails.Yr15.Vs30yrMin,
                vs30yrMax: raw.RefiGuardrails.Yr15.Vs30yrMax,
              }
            : undefined,
        }
      : undefined,
  };
}

// --- Current config (app_config, PK "config", RK "estimated-rate") -------------------------------

async function backfillCurrentConfig() {
  console.log('\n=== app_config["estimated-rate"] ===');
  const client = tableClient('AppConfig');
  let entity;
  try {
    entity = await client.getEntity('config', 'estimated-rate');
  } catch (e) {
    if (e.statusCode === 404) {
      console.log('  (no row in Azure — nothing to backfill; D1 will seed factory defaults on first read, which is correct if this config was never customized)');
      return;
    }
    throw e;
  }

  const raw = entity.Json ? JSON.parse(entity.Json) : {};
  const camelCased = transformRateConfig(raw);

  console.log('  Sanity check — a few key values from the real config:');
  console.log(`    anchorCreditScore=${camelCased.anchorCreditScore}  anchorLtv=${camelCased.anchorLtv}`);
  console.log(`    fallbackRate30=${camelCased.fallbackRate30}  fallbackRate15=${camelCased.fallbackRate15}`);
  console.log(`    llpa tiers: ${Object.keys(camelCased.llpa).length}  eligibilityRules: ${camelCased.eligibilityRules.length}`);

  await d1Exec(
    `INSERT INTO app_config (key, json, version, updated_at, updated_by) VALUES ('estimated-rate', ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET json=excluded.json, version=excluded.version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    [JSON.stringify(camelCased), entity.Version || 1, toEpoch(entity.UpdatedUtc, 'estimated-rate'), entity.UpdatedBy || null]
  );
  console.log('  wrote estimated-rate config');
}

// --- Value-trail history (AppConfig, PK "history", RK = zero-padded version) ---------------------
// The Azure history entity only ever stored a handful of SCALAR columns (not a full config
// snapshot — see rateConfigStore.js's doc comment on this asymmetry), so this backfill can only
// carry those same scalars forward. That's fine: the admin history UI only ever displayed those
// specific tracked fields.

async function backfillHistory() {
  console.log('\n=== rate_config_history ===');
  const client = tableClient('AppConfig');
  let n = 0;
  for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'history'` } })) {
    const partial = {
      anchorCreditScore: e.AnchorCreditScore ?? 0,
      anchorLtv: e.AnchorLtv ?? 0,
      deltaRefi30AddOn: e.DeltaRefi30AddOn ?? 0,
      deltaInvSecondHomeRefi30AddOn: e.DeltaInvSecondHomeRefi30AddOn ?? 0,
      cltvSurcharge: { amount: e.CltvAmount ?? 0 },
    };
    await d1Exec(
      `INSERT INTO rate_config_history (version, json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [e.Version || parseInt(e.rowKey, 10), JSON.stringify(partial), toEpoch(e.UpdatedUtc, `history/${e.rowKey}`), e.UpdatedBy || '']
    );
    n++;
  }
  console.log(`  wrote ${n} history row(s)`);
}

const TASKS = { config: backfillCurrentConfig, history: backfillHistory };

if (DRY_RUN) console.log('*** DRY RUN — no D1 writes will be made ***');

(async () => {
  const toRun = ONLY ? [ONLY] : Object.keys(TASKS);
  for (const name of toRun) {
    if (!TASKS[name]) fail(`Unknown --only value '${name}'. Valid: ${Object.keys(TASKS).join(', ')}`);
    await TASKS[name]();
  }
  console.log('\nDone.');
})().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
