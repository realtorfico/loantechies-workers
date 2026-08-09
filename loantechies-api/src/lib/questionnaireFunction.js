// Thin HTTP wrapper for the "Fill out a questionnaire to return" download on the estimate page —
// see questionnairePdf.js for the actual PDF generation. Anonymous: the base forms and the
// loan-originator contact info they embed are already public.
//
// Base PDFs and fonts are bundled directly into the Worker (wrangler.jsonc's "Data" module rule
// turns these imports into Uint8Arrays at build time) rather than fetched from R2/KV — they're
// static template assets shipped with the code, not user content, same as PdfSharpCore's
// Assets/-folder-copied-to-output-dir approach in the C#.
import { badRequest, json } from './http.js';
import { loadQuestionnaireConfig } from './questionnaireConfig.js';
import { loadConfigJson } from './configStore.js';
import { build } from './questionnairePdf.js';
import purchaseBasePdf from '../../assets/questionnaires/purchase-base.pdf';
import refinanceBasePdf from '../../assets/questionnaires/refinance-base.pdf';
import dejaVuSansRegular from '../../assets/fonts/DejaVuSans.ttf';
import dejaVuSansBold from '../../assets/fonts/DejaVuSans-Bold.ttf';

// Mirrors contactConfig.js's DEFAULTS for the fields this PDF actually reads — kept local rather
// than importing contactConfig.js's private DEFAULTS to avoid coupling to its internal shape.
const CONTACT_DEFAULTS = {
  callEnabled: true, phone: '',
  whatsappEnabled: true, whatsapp: '',
  calendlyEnabled: true, calendlyUrl: '',
};

export async function getQuestionnairePdf(request, env) {
  const url = new URL(request.url);
  const purposeRaw = (url.searchParams.get('purpose') || '').trim().toLowerCase();
  const refi = purposeRaw === 'refinance';
  const purchase = purposeRaw === 'purchase';
  if (!refi && !purchase) return badRequest("purpose must be 'Purchase' or 'Refinance'.");

  const basePdfBytes = refi ? refinanceBasePdf : purchaseBasePdf;

  const [questionnaireCfg, contactRaw] = await Promise.all([
    loadQuestionnaireConfig(env),
    loadConfigJson(env, 'contact'),
  ]);
  const contact = { ...CONTACT_DEFAULTS, ...(contactRaw || {}) };

  let merged;
  try {
    merged = await build(refi, basePdfBytes, questionnaireCfg.returnEmail, contact, dejaVuSansRegular, dejaVuSansBold);
  } catch (e) {
    console.error(`QuestionnairePdf: PDF generation failed — ${e.message}`);
    return json({ error: 'Could not generate the questionnaire PDF.' }, 500);
  }

  const downloadName = refi ? 'LoanTechies-Refinance-Questionnaire.pdf' : 'LoanTechies-Purchase-Questionnaire.pdf';
  return new Response(merged, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${downloadName}"`,
    },
  });
}
