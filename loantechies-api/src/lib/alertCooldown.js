// Port of Utils/AlertCooldownStore.cs — durable, cross-instance "at most once per N minutes" gate
// for alert emails, now backed by D1's alert_cooldowns table instead of Azure Table Storage's
// AppConfig (PK "alert-cooldown"). MUST stay a durable D1 write, not an in-memory Map — this class
// exists because of a real 2026-07-04 incident where in-memory cooldowns reset on every Azure
// Functions cold start and re-fired far more often than intended; a redeployed/restarted Workers
// isolate must not forget the cooldown either.
import { nowSeconds } from './http.js';

// True if it's been at least cooldownMinutes since this alert `kind` last fired (or never fired)
// — and if so, records "now" as the new last-fired time so the caller can go ahead and send.
// Fails OPEN on any D1 error: an occasional duplicate alert is a much smaller problem than
// silently never alerting again.
export async function shouldAlert(env, kind, cooldownMinutes) {
  try {
    const now = nowSeconds();
    const row = await env.DB.prepare('SELECT last_fired_at FROM alert_cooldowns WHERE kind = ?').bind(kind).first();
    if (row && now - row.last_fired_at < cooldownMinutes * 60) return false; // still within cooldown

    await env.DB.prepare(
      `INSERT INTO alert_cooldowns (kind, last_fired_at) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET last_fired_at = excluded.last_fired_at`
    ).bind(kind, now).run();
    return true;
  } catch (e) {
    console.warn(`alertCooldown.shouldAlert('${kind}') failed — ${e.message}`);
    return true; // fail open — see module doc comment
  }
}
