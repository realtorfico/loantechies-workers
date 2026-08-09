// Port of Config/ContactConfig.cs — admin-editable "talk to a human" contact channels shown on
// gated pages. Public read (no secrets in this data), Access-gated save.
import { loadConfigJson, saveConfigJson } from './configStore.js';
import { ok, badRequest, serviceUnavailable, readJsonBody } from './http.js';
import { requireAccess } from './auth.js';

const KEY = 'contact';

const DEFAULTS = {
  callEnabled: true,
  phone: '',
  smsEnabled: true,
  sms: '',
  whatsappEnabled: true,
  whatsapp: '',
  calendlyEnabled: true,
  calendlyUrl: 'https://calendly.com/softician/mortgage-notary-realestate',
  callbackEnabled: true,
  message: "Hi Anand — I'd like to talk about my mortgage options.",
  headline: 'Prefer to talk to a real person?',
  subtext: 'No form needed — reach me or my team directly.',
  showEstimateBanner: true,
};

function trim(s, max) {
  s = (s || '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// GET site/contact-config — anonymous
export async function getContactConfig(request, env) {
  const c = (await loadConfigJson(env, KEY)) || DEFAULTS;
  return ok({ ...DEFAULTS, ...c });
}

// POST console/contact-config/save — Access-gated
export async function saveContactConfig(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const dto = await readJsonBody(request);
  if (!dto) return badRequest('Missing or invalid JSON.');

  dto.phone = trim(dto.phone, 40);
  dto.sms = trim(dto.sms, 40);
  dto.whatsapp = trim(dto.whatsapp, 40);
  dto.calendlyUrl = trim(dto.calendlyUrl, 300);
  dto.message = trim(dto.message, 300);
  dto.headline = trim(dto.headline, 120);
  dto.subtext = trim(dto.subtext, 240);

  try {
    await saveConfigJson(env, KEY, dto, email);
    return ok({ ok: true });
  } catch {
    return serviceUnavailable('Could not save contact settings.');
  }
}
