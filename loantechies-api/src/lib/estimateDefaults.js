// Port of Config/EstimateDefaults.cs — admin-editable DEFAULT values and MIN/MAX limits for the
// public "What's My Rate" / estimate page. Public read (form defaults/limits), Access-gated save.
// The FieldKinds allowlist, hard bounds, and factory defaults below are copied verbatim from the
// C# (field-for-field) — this is validation logic the save route depends on, not just storage.
import { loadConfigJson, saveConfigJson } from './configStore.js';
import { ok, json, badRequest, serviceUnavailable, readJsonBody } from './http.js';
import { requireAccess } from './auth.js';

const KEY = 'estimate-defaults';

// money = whole-dollar amount; rate = an interest rate %; percent = a 0-100 percentage.
export const FIELD_KINDS = {
  price: 'money',
  downPayment: 'money',
  value: 'money',
  assessedValue: 'money',
  currentBalance: 'money',
  currentRate: 'rate',
  income: 'money',
  debts: 'money',
  taxRate: 'percent',
  hoa: 'money',
  mello: 'money',
};

function hardBounds(kind) {
  if (kind === 'rate') return [0, 25];
  if (kind === 'percent') return [0, 100];
  return [0, 1_000_000_000]; // money
}

// The current hardcoded estimate-page behavior, expressed as config. Seed source only.
export function factoryDefaults() {
  return {
    price: { default: 650000, min: 50000, max: 100_000_000 },
    downPayment: { default: 130000, min: 0, max: 100_000_000 },
    value: { default: 1000000, min: 50000, max: 100_000_000 },
    assessedValue: { default: 1000000, min: 0, max: 100_000_000 },
    currentBalance: { default: 800000, min: 0, max: 100_000_000 },
    currentRate: { default: 6.75, min: 0.01, max: 25 },
    income: { default: 25000, min: 0, max: 10_000_000 },
    debts: { default: 600, min: 0, max: 10_000_000 },
    taxRate: { default: 1.15, min: 0, max: 10 },
    hoa: { default: 0, min: 0, max: 1_000_000 },
    mello: { default: 0, min: 0, max: 1_000_000 },
  };
}

// Heal a loaded/incoming config: drop unknown keys, backfill missing fields from factory defaults.
function ensureComplete(fields) {
  fields = fields || {};
  const dflt = factoryDefaults();
  for (const key of Object.keys(fields)) {
    if (!(key in FIELD_KINDS)) delete fields[key];
  }
  for (const key of Object.keys(dflt)) {
    if (!fields[key]) fields[key] = dflt[key];
  }
  return fields;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Field errors (empty == valid). Each field: finite, in hard bounds, and min <= default <= max.
function validate(fields) {
  const errors = [];
  if (!fields) return ['fields: missing.'];
  for (const [key, kind] of Object.entries(FIELD_KINDS)) {
    const f = fields[key];
    if (!f) {
      errors.push(`${key}: missing.`);
      continue;
    }
    const [lo, hi] = hardBounds(kind);
    if (!finite(f.min) || f.min < lo || f.min > hi) errors.push(`${key}.min: must be between ${lo} and ${hi}.`);
    if (!finite(f.max) || f.max < lo || f.max > hi) errors.push(`${key}.max: must be between ${lo} and ${hi}.`);
    if (finite(f.min) && finite(f.max) && f.min > f.max) errors.push(`${key}: min must be <= max.`);
    if (!finite(f.default) || f.default < f.min || f.default > f.max)
      errors.push(`${key}.default: must be between its min and max.`);
  }
  return errors;
}

// GET site/estimate-defaults — anonymous
export async function getEstimateDefaults(request, env) {
  const c = await loadConfigJson(env, KEY);
  const fields = c ? ensureComplete(c.fields) : factoryDefaults();
  return ok({ fields });
}

// GET console/estimate-defaults — Access-gated
export async function getEstimateDefaultsConsole(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });
  const c = await loadConfigJson(env, KEY);
  const fields = c ? ensureComplete(c.fields) : factoryDefaults();
  const kinds = Object.fromEntries(Object.entries(FIELD_KINDS));
  return ok({ fields, defaults: factoryDefaults(), kinds });
}

// POST console/estimate-defaults/save — Access-gated
export async function saveEstimateDefaults(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const dto = await readJsonBody(request);
  if (!dto) return badRequest('Missing or invalid JSON.');

  const fields = ensureComplete(dto.fields);
  const errors = validate(fields);
  if (errors.length > 0) return json({ errors }, 400);

  try {
    await saveConfigJson(env, KEY, { fields }, email);
    return ok({ ok: true });
  } catch {
    return serviceUnavailable('Could not save estimate defaults.');
  }
}
