// Port of Config/FeatureFlagsConfig.cs — site-wide feature toggles. Public read (no secrets),
// Access-gated save. Currently one flag: preApprovalEnabled, defaults OFF.
import { loadConfigJson, saveConfigJson } from './configStore.js';
import { ok, badRequest, serviceUnavailable, readJsonBody } from './http.js';
import { requireAccess } from './auth.js';

const KEY = 'feature-flags';
const DEFAULTS = { preApprovalEnabled: false };

// GET site/feature-flags — anonymous
export async function getFeatureFlags(request, env) {
  const f = (await loadConfigJson(env, KEY)) || DEFAULTS;
  return ok({ preApprovalEnabled: !!f.preApprovalEnabled });
}

// POST console/feature-flags/save — Access-gated
export async function saveFeatureFlags(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const dto = await readJsonBody(request);
  if (!dto) return badRequest('Missing or invalid JSON.');

  try {
    await saveConfigJson(env, KEY, { preApprovalEnabled: !!dto.preApprovalEnabled }, email);
    return ok({ ok: true });
  } catch {
    return serviceUnavailable('Could not save feature flags.');
  }
}
