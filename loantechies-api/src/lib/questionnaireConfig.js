// Port of Config/QuestionnaireConfig.cs — admin-editable return-email for the questionnaire PDF
// cover page. No public GET (only read server-side when building the PDF — see the pdf.js port,
// not yet migrated), so both routes here are Access-gated.
import { loadConfigJson, saveConfigJson } from './configStore.js';
import { ok, badRequest, serviceUnavailable, readJsonBody } from './http.js';
import { requireAccess } from './auth.js';

const KEY = 'questionnaire';
const DEFAULTS = { returnEmail: '' };

// GET console/questionnaire-config — Access-gated
export async function getQuestionnaireConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });
  const c = (await loadConfigJson(env, KEY)) || DEFAULTS;
  return ok({ returnEmail: c.returnEmail || '' });
}

// POST console/questionnaire-config/save — Access-gated
export async function saveQuestionnaireConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const dto = await readJsonBody(request);
  if (!dto) return badRequest('Missing or invalid JSON.');

  let returnEmail = (dto.returnEmail || '').trim();
  if (returnEmail.length > 200) returnEmail = returnEmail.slice(0, 200);
  if (returnEmail.length > 0 && !returnEmail.includes('@'))
    return badRequest("Return email doesn't look like a valid email address.");

  try {
    await saveConfigJson(env, KEY, { returnEmail }, email);
    return ok({ ok: true });
  } catch {
    return serviceUnavailable('Could not save questionnaire settings.');
  }
}

// Internal read for the (not-yet-migrated) PDF builder — same shape callers will want once pdf.js lands.
export async function loadQuestionnaireConfig(env) {
  return (await loadConfigJson(env, KEY)) || DEFAULTS;
}
