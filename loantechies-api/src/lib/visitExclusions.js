// Port of Config/VisitExclusions.cs — admin-editable rules for hiding owner/internal visits from
// the dashboard visitor log. Two kinds of rule: IP (matched on write, beacon dropped) and
// name+location (name only known at read time via the lead join, filtered/purged in visits.js).
// Both routes are Access-gated (unlike most other config stores — this data isn't public).
import { loadConfigJson, saveConfigJson } from './configStore.js';
import { ok, badRequest, serviceUnavailable, readJsonBody } from './http.js';
import { requireAccess } from './auth.js';

const KEY = 'visit-exclusions';

// Factory defaults — the original hardcoded rules, so behavior is unchanged until an admin edits.
export function defaults() {
  return { ips: ['73.41.214.245'], nameRules: [{ name: 'Anand', location: 'Fresno' }] };
}

export async function loadExclusions(env) {
  const c = await loadConfigJson(env, KEY);
  if (!c) return defaults();
  return { ips: c.ips || [], nameRules: c.nameRules || [] };
}

export function matchesIp(exclusions, ip) {
  if (!ip || !exclusions.ips) return false;
  const t = ip.trim().toLowerCase();
  return exclusions.ips.some((x) => x && x.trim().toLowerCase() === t);
}

function nameMatches(rule, name) {
  if (!name) return false;
  const target = rule.name.trim().toLowerCase();
  if (name.trim().toLowerCase() === target) return true;
  return name.split(/[\s\t]+/).filter(Boolean).some((tok) => tok.toLowerCase() === target);
}

function containsCi(haystack, needle) {
  return !!haystack && haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

function ruleMatches(rule, name, city, region) {
  const isEmpty = !rule.name?.trim() && !rule.location?.trim();
  if (isEmpty) return false; // never match on a blank rule (would hide everyone)
  const nameOk = !rule.name?.trim() || nameMatches(rule, name);
  const locOk = !rule.location?.trim() || containsCi(city, rule.location) || containsCi(region, rule.location);
  return nameOk && locOk;
}

export function matchesNameLocation(exclusions, name, city, region) {
  return (exclusions.nameRules || []).some((r) => r && ruleMatches(r, name, city, region));
}

export function isExcludedVisit(exclusions, ip, name, city, region) {
  return matchesIp(exclusions, ip) || matchesNameLocation(exclusions, name, city, region);
}

function trim(s, max) {
  s = (s || '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// GET console/visit-exclusions — Access-gated
export async function getVisitExclusions(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });
  const c = await loadExclusions(env);
  return ok({
    ips: c.ips,
    nameRules: c.nameRules.map((r) => ({ name: r.name || '', location: r.location || '' })),
  });
}

// POST console/visit-exclusions/save — Access-gated
export async function saveVisitExclusions(request, env) {
  const email = await requireAccess(request, env);
  if (!email) return new Response(null, { status: 401 });

  const dto = await readJsonBody(request);
  if (!dto) return badRequest('Missing or invalid JSON.');

  const seenIps = new Set();
  const ips = [];
  for (const raw of dto.ips || []) {
    const t = trim(raw, 45);
    if (!t || seenIps.has(t.toLowerCase())) continue;
    seenIps.add(t.toLowerCase());
    ips.push(t);
    if (ips.length >= 200) break;
  }
  const nameRules = (dto.nameRules || [])
    .map((r) => ({ name: trim(r?.name, 80), location: trim(r?.location, 80) }))
    .filter((r) => r.name || r.location)
    .slice(0, 200);

  try {
    await saveConfigJson(env, KEY, { ips, nameRules }, email);
    return ok({ ok: true });
  } catch {
    return serviceUnavailable('Could not save visitor exclusions.');
  }
}
