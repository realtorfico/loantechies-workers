// Round-half-to-even ("banker's rounding") matching .NET's Math.Round(double, int) default
// (MidpointRounding.ToEven) — JS's native Math.round always rounds .5 toward positive infinity
// (asymmetric for negatives: Math.round(-2.5) === -2, not -3), which silently disagrees with C#
// on exact midpoints. Every pricing-math file in this port (rateConfig.js, regZApr.js,
// providentPricing.js, estimatedRate.js, rateConfigAdmin.js, loanFactoryRatesProvider.js,
// calcMath.js) rounds computed deltas/rates to a fixed decimal precision, so this single helper
// is the one place that needs to get the rounding MODE right for the whole port to match the C#
// bit-for-bit rather than just "close enough."
//
// Real-world impact of getting this wrong is tiny (a one-unit difference in the last decimal
// place, e.g. 0.0001 percentage points on a rate) — but "matches the old system exactly" is worth
// more than "close enough" for pricing math specifically, so this is a real fix, not just a
// theoretical nicety.
export function roundHalfEven(value, digits = 0) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;

  let rounded;
  if (Math.abs(frac - 0.5) < 1e-9) {
    // Exact midpoint — round to the nearest EVEN integer, not always up.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}
