/* Who the scanner is scanning for.

   A "tenant" is one person's view of the screener: their symbols, their
   criteria, their alert destination, their history. The scan loop used to have
   exactly one of these implied by global state; now it iterates them.

   The important property, and the reason this file exists rather than the loop
   reading the database inline:

     PRICES ARE FETCHED ONCE. Criteria are evaluated per user.

   Fetching a quote is the expensive part — a network round trip per symbol,
   rate-limited, ~0.5s each. Evaluating criteria against a quote already in
   memory is microseconds. So the scanner fetches the UNION of every user's
   universe in one pass and then replays that snapshot through each tenant's own
   rules. Five people watching the Nifty 500 costs 500 fetches, not 2,500. Doing
   it the other way — a scan per user — is what makes per-user universes look
   impossible on a free tier, and it is not necessary. */

import * as db from "./db.js";
import * as ud from "./userData.js";

/* Tenant construction hits the database several times, and the scan loop asks
   for tenants on every pass. Cached briefly: a criteria change should take
   effect within a scan or two, not instantly, and not require a restart. */
const TTL_MS = 60_000;
let cache = { at: 0, tenants: null };

export const invalidate = () => { cache = { at: 0, tenants: null }; };

/**
 * The single-user tenant.
 *
 * Not a special case bolted on — it is the shape every other tenant has, filled
 * from the global file-backed modules. That keeps one code path through the
 * scanner: without it, `scan()` would need a branch at every point it touches
 * user data, and those branches are where a multi-user bug hides for a month.
 */
export function legacyTenant({ profiles, symbols, groups, telegram, alertsOn = true }) {
  return {
    id: null,                       // no account
    email: null,
    legacy: true,
    profiles, symbols: new Set(symbols), groups,
    telegram, alertsOn,
  };
}

/** Every active account, with everything the scanner needs about them. */
export async function tenants({ force = false } = {}) {
  if (!db.enabled) return [];
  if (!force && cache.tenants && Date.now() - cache.at < TTL_MS) return cache.tenants;

  const users = await ud.activeUsers();
  const out = [];
  for (const u of users) {
    const [profiles, groups, p] = await Promise.all([
      ud.config.get(u.id),
      ud.universe.groups(u.id),
      ud.prefs.get(u.id),
    ]);
    const symbols = new Set(Object.values(groups).flat());
    out.push({
      id: u.id, email: u.email, legacy: false,
      profiles: profiles || {},
      symbols, groups,
      telegram: p.telegram,
      alertsOn: p.alertsOn,
      alertProfiles: p.alertProfiles,
    });
  }
  cache = { at: Date.now(), tenants: out };
  return out;
}

/**
 * Every symbol any active user watches.
 *
 * Read straight from the database rather than from the tenant cache: this is
 * what the fetcher works from, and it must not lag behind a symbol someone added
 * a minute ago. `MAX` bounds the whole instance, not one account — otherwise
 * five users with a thousand symbols each is a five-thousand-symbol scan and the
 * pass never finishes inside its interval.
 */
export async function unionUniverse(MAX) {
  if (!db.enabled) return null;
  const syms = await ud.universe.unionAll();
  if (syms.length > MAX) {
    console.warn(`[tenants] union universe is ${syms.length} symbols, over the ${MAX} cap — scanning the first ${MAX}. Symbols beyond the cap are NOT evaluated for anyone.`);
    return syms.slice(0, MAX);
  }
  return syms;
}

/* ── seeding ──────────────────────────────────────────────────────────── */

/**
 * A new account starts with the shipped defaults, not with nothing.
 *
 * An empty universe and empty criteria produce an empty dashboard, which reads
 * as broken rather than as new. The defaults are copied, not shared — the point
 * of per-user config is that changing yours does not change anyone else's, and
 * handing two accounts a reference to the same object would defeat that in the
 * least visible way possible.
 */
export async function seedUser(userId, { profiles, symbols, groups }) {
  const existing = await ud.config.get(userId);
  if (existing && Object.keys(existing).length) return { seeded: false };

  await ud.config.put(userId, JSON.parse(JSON.stringify(profiles)));

  const g = groups && Object.keys(groups).length ? groups : { Default: symbols || [] };
  let added = 0;
  for (const [name, syms] of Object.entries(g)) {
    added += await ud.universe.add(userId, name, [...new Set(syms)]);
  }
  return { seeded: true, symbols: added, groups: Object.keys(g).length };
}

/**
 * Move the single-user instance's data into the owner's account, once.
 *
 * Without this, the person who has been running this thing signs in for the
 * first time and finds their holdings, their trade record and their criteria
 * gone — technically still on disk, invisible in the app. The files are left
 * untouched: this reads them and writes rows, so if anything here is wrong the
 * original is still there to try again from.
 *
 * Guarded on the target being empty, so a redeploy cannot re-import and
 * duplicate a trade log.
 */
export async function migrateLegacy(userId, { profiles, groups, holdings, trades, history }) {
  const report = { config: 0, symbols: 0, holdings: 0, trades: 0, signals: 0, skipped: [] };

  const existingCfg = await ud.config.get(userId);
  if (existingCfg && Object.keys(existingCfg).length) {
    report.skipped.push("config — the account already has criteria");
  } else if (profiles && Object.keys(profiles).length) {
    await ud.config.put(userId, JSON.parse(JSON.stringify(profiles)));
    report.config = Object.keys(profiles).length;
  }

  const haveSyms = await ud.universe.symbols(userId);
  if (haveSyms.length) {
    report.skipped.push(`universe — the account already has ${haveSyms.length} symbols`);
  } else {
    for (const [name, syms] of Object.entries(groups || {})) {
      report.symbols += await ud.universe.add(userId, name, [...new Set(syms)]);
    }
  }

  const haveHoldings = await ud.holdings.all(userId);
  if (haveHoldings.length) {
    report.skipped.push(`holdings — the account already has ${haveHoldings.length}`);
  } else {
    for (const h of holdings || []) { await ud.holdings.put(userId, h); report.holdings++; }
  }

  const haveTrades = await ud.trades.all(userId);
  if (haveTrades.length) {
    report.skipped.push(`paper trades — the account already has ${haveTrades.length}`);
  } else {
    for (const t of trades || []) { await ud.trades.put(userId, t); report.trades++; }
  }

  const haveSignals = await ud.signals.list(userId, { limit: 1 });
  if (haveSignals.length) {
    report.skipped.push("signal history — the account already has records");
  } else {
    for (const rec of history || []) {
      if (!rec?.id || !rec?.firedAt) continue;   // a record with no id cannot be deduped
      await ud.signals.record(userId, rec);
      report.signals++;
    }
  }
  return report;
}
