/* Per-user application data, backed by Postgres.

   Every function here takes a userId as its first argument, and there is no
   variant that does not. That is the whole design: the previous modules read a
   file that was implicitly "the" holdings, and the way that becomes a leak is
   not a dramatic bug — it is one query written without a WHERE clause. Making
   the user id a required positional argument means a forgotten scope is a
   TypeError at the call site rather than another person's portfolio on screen.

   The row shape is `{ id, user_id, data JSONB }` rather than a column per field.
   The objects these replace were free-form JSON written by modules that still
   own their own validation, and re-deriving a strict schema for them here would
   mean two definitions of a holding that can disagree. What Postgres is used for
   is the part it is actually needed for: isolation, atomicity and an index on
   user_id. */

import { query } from "./db.js";

const rowsOf = r => r.rows.map(x => ({ ...x.data, id: x.id }));

/* ── holdings ─────────────────────────────────────────────────────────── */

export const holdings = {
  async all(userId) {
    const r = await query(
      "SELECT id, data FROM holdings WHERE user_id = $1 ORDER BY created_at", [userId]);
    return rowsOf(r);
  },
  async open(userId) {
    return (await holdings.all(userId)).filter(h => h.status !== "closed");
  },
  async get(userId, id) {
    const r = await query(
      "SELECT id, data FROM holdings WHERE user_id = $1 AND id = $2", [userId, id]);
    return r.rows[0] ? { ...r.rows[0].data, id: r.rows[0].id } : null;
  },
  async put(userId, holding) {
    const { id, ...data } = holding;
    await query(
      `INSERT INTO holdings (id, user_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = now()
       WHERE holdings.user_id = $2`,
      [id, userId, JSON.stringify(data)]);
    return holding;
  },
  /* The user id is in the DELETE, not checked before it. A check-then-delete
     lets one user remove another's row by guessing an id; the WHERE makes the
     database refuse, and rowCount reports honestly whether anything happened. */
  async remove(userId, id) {
    const r = await query("DELETE FROM holdings WHERE user_id = $1 AND id = $2", [userId, id]);
    return r.rowCount > 0;
  },
};

/* ── paper trades ─────────────────────────────────────────────────────── */

export const trades = {
  async all(userId) {
    const r = await query(
      "SELECT id, data FROM paper_trades WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return rowsOf(r);
  },
  async get(userId, id) {
    const r = await query(
      "SELECT id, data FROM paper_trades WHERE user_id = $1 AND id = $2", [userId, id]);
    return r.rows[0] ? { ...r.rows[0].data, id: r.rows[0].id } : null;
  },
  async put(userId, trade) {
    const { id, ...data } = trade;
    await query(
      `INSERT INTO paper_trades (id, user_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = now()
       WHERE paper_trades.user_id = $2`,
      [id, userId, JSON.stringify(data)]);
    return trade;
  },
  async remove(userId, id) {
    const r = await query("DELETE FROM paper_trades WHERE user_id = $1 AND id = $2", [userId, id]);
    return r.rowCount > 0;
  },
};

/* ── signal history ───────────────────────────────────────────────────── */

export const signals = {
  async record(userId, rec) {
    const { id, symbol, profileId, firedAt } = rec;
    await query(
      `INSERT INTO signal_history (id, user_id, symbol, profile_id, fired_at, data)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [id, userId, symbol, profileId ?? null, firedAt, JSON.stringify(rec)]);
    return rec;
  },
  async list(userId, { from, to, limit = 5000 } = {}) {
    const lo = from ? Date.parse(from) : 0;
    const hi = to ? Date.parse(to) + 86_400_000 : Number.MAX_SAFE_INTEGER;
    const r = await query(
      `SELECT data FROM signal_history
        WHERE user_id = $1 AND fired_at >= $2 AND fired_at < $3
        ORDER BY fired_at DESC LIMIT $4`,
      [userId, lo, hi, limit]);
    return r.rows.map(x => x.data);
  },
  async forSymbol(userId, symbol, limit = 50) {
    const r = await query(
      `SELECT data FROM signal_history WHERE user_id = $1 AND symbol = $2
        ORDER BY fired_at DESC LIMIT $3`, [userId, symbol, limit]);
    return r.rows.map(x => x.data);
  },
  async update(userId, id, patch) {
    const r = await query(
      "SELECT data FROM signal_history WHERE user_id = $1 AND id = $2", [userId, id]);
    if (!r.rows[0]) return null;
    const merged = { ...r.rows[0].data, ...patch };
    await query("UPDATE signal_history SET data = $1 WHERE user_id = $2 AND id = $3",
      [JSON.stringify(merged), userId, id]);
    return merged;
  },
  /* Fired-today dedupe survives a restart when it is read from what was actually
     recorded. The in-memory Set was lost on every redeploy, and a redeploy
     mid-session meant every locked stock alerted a second time. */
  async firedOn(userId, dayStartMs) {
    const r = await query(
      `SELECT DISTINCT symbol, profile_id FROM signal_history
        WHERE user_id = $1 AND fired_at >= $2`, [userId, dayStartMs]);
    return new Set(r.rows.map(x => `${x.profile_id}:${x.symbol}`));
  },
};

/* ── universe ─────────────────────────────────────────────────────────── */

export const universe = {
  async groups(userId) {
    const r = await query(
      "SELECT group_name, symbol FROM user_universe WHERE user_id = $1 ORDER BY group_name, symbol",
      [userId]);
    const out = {};
    for (const { group_name, symbol } of r.rows) (out[group_name] ||= []).push(symbol);
    return out;
  },
  async symbols(userId) {
    const r = await query(
      "SELECT DISTINCT symbol FROM user_universe WHERE user_id = $1", [userId]);
    return r.rows.map(x => x.symbol);
  },
  async add(userId, group, syms) {
    if (!syms.length) return 0;
    /* One statement with unnest rather than a loop: 500 symbols is 500 round
       trips otherwise, and on a hosted database that is the difference between
       an instant response and a timeout. */
    const r = await query(
      `INSERT INTO user_universe (user_id, group_name, symbol)
       SELECT $1, $2, unnest($3::text[])
       ON CONFLICT DO NOTHING`,
      [userId, group, syms]);
    return r.rowCount;
  },
  async remove(userId, syms, group = null) {
    const r = group
      ? await query("DELETE FROM user_universe WHERE user_id = $1 AND group_name = $2 AND symbol = ANY($3)", [userId, group, syms])
      : await query("DELETE FROM user_universe WHERE user_id = $1 AND symbol = ANY($2)", [userId, syms]);
    return r.rowCount;
  },
  async renameGroup(userId, from, to) {
    const r = await query(
      "UPDATE user_universe SET group_name = $3 WHERE user_id = $1 AND group_name = $2",
      [userId, from, to]);
    return r.rowCount;
  },
  async dropGroup(userId, group) {
    const r = await query(
      "DELETE FROM user_universe WHERE user_id = $1 AND group_name = $2", [userId, group]);
    return r.rowCount;
  },
  /** The union across every active user — what the scanner actually fetches. */
  async unionAll() {
    const r = await query(
      `SELECT DISTINCT uu.symbol FROM user_universe uu
         JOIN users u ON u.id = uu.user_id
        WHERE u.status = 'active'`);
    return r.rows.map(x => x.symbol);
  },
};

/* ── config (criteria/profiles) ───────────────────────────────────────── */

export const config = {
  async get(userId) {
    const r = await query("SELECT profiles FROM user_config WHERE user_id = $1", [userId]);
    return r.rows[0]?.profiles ?? null;
  },
  async put(userId, profiles) {
    await query(
      `INSERT INTO user_config (user_id, profiles) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET profiles = $2, updated_at = now()`,
      [userId, JSON.stringify(profiles)]);
    return profiles;
  },
};

/* ── preferences, including Telegram ──────────────────────────────────── */

export const prefs = {
  async get(userId) {
    const r = await query(
      `SELECT telegram_token, telegram_chat_id, alerts_on, alert_profiles
         FROM user_prefs WHERE user_id = $1`, [userId]);
    const p = r.rows[0];
    return {
      telegram: { token: p?.telegram_token ?? null, chatId: p?.telegram_chat_id ?? null },
      alertsOn: p?.alerts_on ?? true,
      alertProfiles: p?.alert_profiles ?? [],
    };
  },
  /**
   * Masked for anything the browser can reach.
   *
   * The single-user app read Telegram credentials from the environment, so they
   * were never in a response. Now they are per-user and stored, and a settings
   * page that echoes back what it saved is the obvious way to leak a bot token
   * to anyone who gets a session. The raw values leave this module only for
   * sending.
   */
  async publicGet(userId) {
    const p = await prefs.get(userId);
    const mask = v => (v ? `••••${String(v).slice(-4)}` : null);
    return {
      telegram: {
        configured: !!(p.telegram.token && p.telegram.chatId),
        tokenMasked: mask(p.telegram.token),
        chatIdMasked: mask(p.telegram.chatId),
      },
      alertsOn: p.alertsOn,
      alertProfiles: p.alertProfiles,
    };
  },
  async put(userId, { telegramToken, telegramChatId, alertsOn, alertProfiles }) {
    const cur = await prefs.get(userId);
    /* A masked or empty value means "leave it alone" — the same rule the
       single-user config endpoint used. Without it, saving the alert toggle from
       a page that only ever saw `••••1234` would overwrite the real token with
       four dots and silently disarm alerts. */
    const keep = (incoming, existing) =>
      (incoming === undefined || incoming === null || incoming === "" || String(incoming).startsWith("••••"))
        ? existing : String(incoming);

    await query(
      `INSERT INTO user_prefs (user_id, telegram_token, telegram_chat_id, alerts_on, alert_profiles)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         telegram_token = $2, telegram_chat_id = $3, alerts_on = $4,
         alert_profiles = $5, updated_at = now()`,
      [userId,
       keep(telegramToken, cur.telegram.token),
       keep(telegramChatId, cur.telegram.chatId),
       alertsOn === undefined ? cur.alertsOn : !!alertsOn,
       JSON.stringify(alertProfiles ?? cur.alertProfiles)]);
    return prefs.publicGet(userId);
  },
};

/** Every active account, for the scan loop. */
export async function activeUsers() {
  const r = await query(
    "SELECT id, email, is_admin FROM users WHERE status = 'active' ORDER BY id");
  return r.rows.map(u => ({ id: u.id, email: u.email, isAdmin: u.is_admin }));
}
