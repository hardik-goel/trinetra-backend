/* Postgres, and the schema that makes this a multi-user application.

   Everything here exists because the app was written for exactly one person.
   Holdings, paper trades, criteria, the universe and the Telegram chat id were
   single global objects on disk. The moment a second person signs in, each of
   those is either split per user or leaked to everyone — and a friend seeing
   your positions is not a rough edge, it is the thing that makes the app
   unusable by anyone you would not hand your broker password to.

   Market data stays where it is. Prices, fundamentals and the F&O list are facts
   about the market, identical for every user, and duplicating them per account
   would multiply the scan cost for no gain. What lives here is what belongs to a
   person.

   The pool is created lazily and the app runs without it: no DATABASE_URL means
   single-user legacy mode, which is what the existing deployment is. That is not
   a fallback for convenience — it is so that adding auth cannot brick a running
   instance if the database is unreachable at boot. */

import pg from "pg";

const URL = process.env.DATABASE_URL || "";
export const enabled = !!URL;

let pool = null;

/* Supabase and Neon both terminate unencrypted connections, and both present
   certificates that Node will not verify against its default CA set on a plain
   connection string. `rejectUnauthorized: false` is the documented setting for
   both; the transport is still TLS, the certificate chain is simply not pinned.
   Stated rather than hidden because "ssl: false" would have been the easy fix
   and it would have sent the password in the clear. */
function makePool() {
  if (pool) return pool;
  if (!URL) throw new Error("DATABASE_URL is not set");
  pool = new pg.Pool({
    connectionString: URL,
    ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
    /* Render's free tier is one small instance, so five is plenty of
       concurrency. Configurable because hosted Postgres caps connections per
       project and a pool that exceeds the cap fails in a way that looks like the
       database being down. */
    max: Math.max(1, +(process.env.DB_POOL_MAX || 5)),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", e => console.warn(`[db] idle client error: ${e.message}`));
  return pool;
}

/* Errors that mean "the connection died", not "the statement was wrong".
   A pooled connection that the server closed while idle fails on its next use,
   and both free tiers do exactly that: Supabase's pooler times out idle clients
   and Neon scales the compute to zero. The first query after a quiet period then
   fails for a reason that has nothing to do with the query — and on a screener
   that sits idle between market sessions, "the first request after a quiet
   period" is most of them. */
const TRANSIENT = new Set([
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND",
  "57P01",   // admin_shutdown — the server closed it
  "57P03",   // cannot_connect_now — still starting up
  "08006", "08003", "08000",   // connection failure / does not exist
]);

const isTransient = e =>
  TRANSIENT.has(e?.code) || /Connection terminated|socket hang up/i.test(e?.message || "");

/**
 * One retry, and only for connection-class failures.
 *
 * Deliberately not a general retry: replaying a statement that failed on a
 * constraint or a syntax error just fails again, and replaying one that
 * partially applied would be worse. A dead socket is the one case where the
 * statement provably never ran.
 */
export async function query(text, params) {
  try {
    return await makePool().query(text, params);
  } catch (e) {
    if (!isTransient(e)) throw e;
    console.warn(`[db] ${e.code || "connection"} on first attempt — retrying once`);
    // The pool hands out a fresh connection; the dead one is discarded by pg.
    return await makePool().query(text, params);
  }
}

/** Run a set of statements in one transaction, rolling back on any failure. */
export async function tx(fn) {
  const client = await makePool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/* ── schema ───────────────────────────────────────────────────────────────
   Applied on boot, idempotent. No migration tool: there is one deployment and
   the alternative is a dependency plus a state table for a schema that fits on
   a screen. Every statement is IF NOT EXISTS so a restart is a no-op. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  email_lower   TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
-- Case-insensitive uniqueness. Without it "Hardik@x.com" and "hardik@x.com" are
-- two accounts, and the second one silently gets an empty portfolio.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (email_lower);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS invites (
  code_hash   TEXT PRIMARY KEY,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  used_at     TIMESTAMPTZ,
  note        TEXT
);

-- Failed logins, for rate limiting. Keyed by email AND by ip so neither a
-- single account nor a single source can be hammered.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_key_at_idx ON auth_attempts (key, at DESC);

/* Per-user application data. Each of these was a JSON file that every request
   read as "the" holdings, "the" trades, "the" criteria. */

CREATE TABLE IF NOT EXISTS user_universe (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name  TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_name, symbol)
);
CREATE INDEX IF NOT EXISTS user_universe_symbol_idx ON user_universe (symbol);

CREATE TABLE IF NOT EXISTS user_config (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profiles    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Telegram credentials are per user and are NOT returned by any read path that
   the browser can reach. The single-user app took them from the environment;
   with several people on one instance each person needs their own chat, or one
   friend's alerts go to another friend's phone. */
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_token    TEXT,
  telegram_chat_id  TEXT,
  alerts_on         BOOLEAN NOT NULL DEFAULT TRUE,
  alert_profiles    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holdings (
  id          TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS holdings_user_idx ON holdings (user_id);

CREATE TABLE IF NOT EXISTS paper_trades (
  id          TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_trades_user_idx ON paper_trades (user_id);

CREATE TABLE IF NOT EXISTS signal_history (
  id          TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  profile_id  TEXT,
  fired_at    BIGINT NOT NULL,
  data        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS signal_history_user_fired_idx ON signal_history (user_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS signal_history_user_symbol_idx ON signal_history (user_id, symbol);
`;

let ready = false;

/** Idempotent. Safe to call on every boot; safe to call twice. */
export async function migrate() {
  if (!enabled) return { ok: false, reason: "DATABASE_URL not set — single-user mode" };
  if (ready) return { ok: true, alreadyApplied: true };
  await query(SCHEMA);
  ready = true;
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  return { ok: true, users: rows[0].n };
}

export const isReady = () => ready;

/** Expired sessions and stale rate-limit rows. Cheap, runs on a timer. */
export async function sweep() {
  if (!enabled || !ready) return;
  try {
    await query("DELETE FROM sessions WHERE expires_at < now()");
    await query("DELETE FROM auth_attempts WHERE at < now() - interval '1 hour'");
  } catch (e) {
    console.warn(`[db] sweep failed: ${e.message}`);
  }
}

/** For /health. Never exposes the connection string. */
export async function status() {
  if (!enabled) return { configured: false, mode: "single-user", detail: "No DATABASE_URL — the instance serves one user from local files." };
  try {
    const t0 = Date.now();
    const { rows } = await query("SELECT count(*)::int AS n FROM users");
    return { configured: true, mode: "multi-user", ok: true, users: rows[0].n, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { configured: true, mode: "multi-user", ok: false, error: e.message };
  }
}
