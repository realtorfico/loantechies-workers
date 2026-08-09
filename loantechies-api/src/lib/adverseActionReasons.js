// Port of Config/AdverseActionReasons.cs — canonical denial-reason checklist for the ECOA/Reg B
// §1002.9(a)(2) Adverse Action Notice (substantially the CFPB Model Form B-1 checklist). Single
// source of truth so the admin UI's checkbox labels and the backend's validation of submitted
// reasons can never drift apart; the backend additionally REJECTS any reason string not on this
// list rather than trusting free text, since these labels become the operative legal disclosure
// sent to a real borrower — see leadPreApprovalStatus.js.
//
// NOT LEGAL ADVICE — this is the well-established Model Form B-1 safe harbor, drafted as a
// starting point. Anand / Loan Factory's compliance desk should confirm this list (and the ECOA
// notice boilerplate) before it's relied on for a real declination.
//
// Deliberately excludes the credit-score-specific reasons from Model Form B-1 (the "credit
// scoring" box) — this app doesn't pull a credit report or use an automated scoring model.

const PAIRS = [
  ['Credit application incomplete', 'Solicitud de crédito incompleta'],
  ['Insufficient number of credit references provided', 'Número insuficiente de referencias de crédito proporcionadas'],
  ['Unacceptable type of credit references provided', 'Tipo de referencias de crédito no aceptable'],
  ['Unable to verify credit references', 'No se pudieron verificar las referencias de crédito'],
  ['Temporary or irregular employment', 'Empleo temporal o irregular'],
  ['Unable to verify employment', 'No se pudo verificar el empleo'],
  ['Length of employment', 'Tiempo de empleo insuficiente'],
  ['Income insufficient for amount of credit requested', 'Ingresos insuficientes para el monto de crédito solicitado'],
  ['Excessive obligations in relation to income', 'Obligaciones excesivas en relación con los ingresos'],
  ['Unable to verify income', 'No se pudieron verificar los ingresos'],
  ['Length of residence', 'Tiempo de residencia insuficiente'],
  ['Temporary residence', 'Residencia temporal'],
  ['Unable to verify residence', 'No se pudo verificar la residencia'],
  ['No credit file', 'Sin historial de crédito'],
  ['Limited credit experience', 'Experiencia de crédito limitada'],
  ['Poor credit performance with us', 'Desempeño de crédito deficiente con nosotros'],
  ['Delinquent past or present credit obligations with others', 'Obligaciones de crédito morosas, pasadas o presentes, con otros acreedores'],
  ['Collection action or judgment', 'Acción de cobranza o sentencia judicial'],
  ['Garnishment or attachment', 'Embargo de bienes o ingresos'],
  ['Foreclosure or repossession', 'Ejecución hipotecaria o reposesión'],
  ['Bankruptcy', 'Bancarrota'],
  ['Number of recent inquiries on credit bureau report', 'Número de consultas recientes en el reporte de crédito'],
  ['Value or type of collateral not sufficient', 'Valor o tipo de garantía insuficiente'],
  ['Other', 'Otro'],
];

export const CANONICAL = PAIRS.map(([en]) => en);

const CANONICAL_SET = new Set(CANONICAL);
const ES_LOOKUP = new Map(PAIRS);

export function isValid(reason) {
  return !!(reason && reason.trim()) && CANONICAL_SET.has(reason);
}

// Spanish translation of a canonical English reason; falls back to the English string itself if
// somehow not found (should not happen for an already-validated reason).
export function toSpanish(reasonEn) {
  return ES_LOOKUP.get(reasonEn || '') ?? reasonEn;
}
