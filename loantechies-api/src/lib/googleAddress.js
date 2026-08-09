// Port of Utils/GoogleAddressVerifier.cs — real US address verification via Google's Address
// Validation API (enableUspsCass:true for genuine USPS deliverability, not just Google's own
// geocoding confidence). No-op (configured:false) until GOOGLE_ADDRESS_VALIDATION_KEY is set,
// same pattern as Turnstile — callers fall back to their own basic format check.
//
// Storage caveat (not code-enforced, a usage discipline carried over from the C#): Google's Maps
// Platform terms cap how long the API's OWN validated/corrected content may be cached (30 days).
// This integration only ever returns Google's suggestion to the caller for the borrower to
// review/apply — nothing here persists a Google response server-side.

const VERIFY_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress';

export async function verify(street, city, state, zip, env) {
  const apiKey = env.GOOGLE_ADDRESS_VALIDATION_KEY;
  if (!apiKey) return { configured: false };

  try {
    const payload = {
      address: {
        regionCode: 'US',
        addressLines: [street || ''],
        locality: city || '',
        administrativeArea: state || '',
        postalCode: zip || '',
      },
      enableUspsCass: true,
    };
    const res = await fetch(`${VERIFY_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      console.warn(`GoogleAddressVerifier: HTTP ${res.status} — ${body}`);
      return { configured: true, deliverable: false };
    }
    return parseResponse(body);
  } catch (e) {
    console.warn(`GoogleAddressVerifier: request failed — ${e.message}`);
    return { configured: true, deliverable: false };
  }
}

// Pure and exported for testing — no network dependency. Malformed JSON or a response with no
// `result` both come back as deliverable:false rather than throwing. Prefers the USPS DPV
// confirmation code when present; falls back to Google's own verdict otherwise.
export function parseResponse(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  const result = parsed?.result;
  if (!result) return { configured: true, deliverable: false, suggestedStreet: null, suggestedCity: null, suggestedState: null, suggestedZip: null };

  const dpv = result.uspsData?.dpvConfirmation;
  let deliverable;
  if (dpv) {
    deliverable = dpv === 'Y' || dpv === 'S' || dpv === 'D';
  } else {
    const granularity = result.verdict?.validationGranularity;
    deliverable = (granularity === 'PREMISE' || granularity === 'SUB_PREMISE') && !(result.verdict?.hasUnconfirmedComponents ?? true);
  }

  const pa = result.address?.postalAddress;
  const suggestedStreet = pa?.addressLines?.length > 0 ? pa.addressLines[0] : null;

  return {
    configured: true,
    deliverable,
    suggestedStreet,
    suggestedCity: pa?.locality ?? null,
    suggestedState: pa?.administrativeArea ?? null,
    suggestedZip: pa?.postalCode ?? null,
  };
}
