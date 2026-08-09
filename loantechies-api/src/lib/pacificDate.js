// Shared Pacific-time date helpers — the business (and LoanFactory's daily email) runs on PT, so
// staleness/business-day comparisons must use Pacific time, never naive UTC (see
// loantechies-pacific-timezone-rule). Dates are represented as "yyyy-MM-dd" strings throughout —
// simpler and safer than JS Date objects for comparison/arithmetic, and matches how dates are
// already stored in D1 (external_rates.id, rate_snapshots.id).
//
// All internal Date-object arithmetic uses UTC methods explicitly (Date.UTC, getUTCDay, etc.),
// never local-time methods — the Workers runtime is always UTC, but local `node` test runs are
// not (they use the dev machine's system timezone), so using local-time methods would make
// behavior diverge between tests and production depending on which machine runs them.

function dateUTC(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)); // m is 1-indexed
}

function toDateStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return dateUTC(y, m, d);
}

export function addDaysStr(s, n) {
  const d = parseDateStr(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateStr(d);
}

export function daysBetween(aStr, bStr) {
  return Math.round((parseDateStr(aStr).getTime() - parseDateStr(bStr).getTime()) / (24 * 3600 * 1000));
}

// The Pacific calendar date ("yyyy-MM-dd") of a UTC instant.
export function pacificDateOf(utcInstant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(utcInstant);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function pacificDateAndHour(utcInstant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(utcInstant);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10);
  return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

// The daily LoanFactory email arrives ~10:03am PT — before that, "today" doesn't have a snapshot
// yet BY DESIGN, so the reference date is still "yesterday" until past this cutoff hour.
const EMAIL_ARRIVAL_CUTOFF_HOUR = 11;

// The Pacific calendar date whose business-day snapshot should already be on hand as of
// utcInstant — "today" once past the arrival cutoff, otherwise still "yesterday".
export function expectedSnapshotReferenceDate(utcInstant) {
  const { dateStr, hour } = pacificDateAndHour(utcInstant);
  return hour < EMAIL_ARRIVAL_CUTOFF_HOUR ? addDaysStr(dateStr, -1) : dateStr;
}

function observedFixed(y, m, d) {
  const dt = dateUTC(y, m, d);
  const dow = dt.getUTCDay();
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1); // Saturday -> observed Friday
  else if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1); // Sunday -> observed Monday
  return toDateStr(dt);
}

// dow: 0=Sunday..6=Saturday (matches Date.getUTCDay()).
function nthWeekdayOfMonth(dow, n, y, m) {
  const first = dateUTC(y, m, 1);
  const offset = (dow - first.getUTCDay() + 7) % 7;
  const result = dateUTC(y, m, 1);
  result.setUTCDate(1 + offset + 7 * (n - 1));
  return toDateStr(result);
}

function lastWeekdayOfMonth(dow, y, m) {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
  const last = dateUTC(y, m, daysInMonth);
  const offset = (last.getUTCDay() - dow + 7) % 7;
  last.setUTCDate(last.getUTCDate() - offset);
  return toDateStr(last);
}

// Best-effort federal-holiday calendar — fixed-date holidays shift to the nearest weekday when
// they fall on a weekend; floating holidays already land on their named weekday.
export function isMajorUsHoliday(dateStr) {
  const y = Number(dateStr.split('-')[0]);
  if (dateStr === observedFixed(y, 1, 1)) return true; // New Year's Day
  if (dateStr === observedFixed(y, 6, 19)) return true; // Juneteenth
  if (dateStr === observedFixed(y, 7, 4)) return true; // Independence Day
  if (dateStr === observedFixed(y, 11, 11)) return true; // Veterans Day
  if (dateStr === observedFixed(y, 12, 25)) return true; // Christmas Day
  if (dateStr === nthWeekdayOfMonth(1, 3, y, 1)) return true; // MLK Day
  if (dateStr === nthWeekdayOfMonth(1, 3, y, 2)) return true; // Presidents Day
  if (dateStr === lastWeekdayOfMonth(1, y, 5)) return true; // Memorial Day
  if (dateStr === nthWeekdayOfMonth(1, 1, y, 9)) return true; // Labor Day
  if (dateStr === nthWeekdayOfMonth(4, 4, y, 11)) return true; // Thanksgiving
  return false;
}

// LoanFactory only emails Mon-Fri, excluding major US holidays.
export function isBusinessDay(dateStr) {
  const dow = parseDateStr(dateStr).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isMajorUsHoliday(dateStr);
}

// Walks back from dateStr to the most recent business day on/before it (inclusive).
export function lastExpectedBusinessDay(dateStr) {
  let d = dateStr;
  while (!isBusinessDay(d)) d = addDaysStr(d, -1);
  return d;
}
