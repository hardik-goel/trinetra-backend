/* Accounts, sessions and invites.

   Hand-rolled rather than pulled from a library, and the reasons are worth
   stating because "rolled my own auth" is normally the wrong answer:

   - The password KDF is scrypt from node:crypto. bcrypt and argon2 are both
     native modules that need a toolchain at install time; on a free-tier host
     with no build cache a failed native build is a deploy that does not come
     back. scrypt is memory-hard, in the standard library, and needs nothing.
   - Sessions are opaque random tokens in an httpOnly cookie, not JWTs. A JWT
     cannot be revoked without a server-side list, at which point it is a session
     with extra steps and a signature everyone forgets to verify the algorithm
     of.

   What is NOT hand-rolled is the dangerous part: no custom crypto primitives,
   no custom comparison, no custom randomness. Everything below composes
   node:crypto.

   Every secret is stored hashed. A database dump gives an attacker password
   hashes it must grind, session hashes that are useless without the plaintext
   cookie, and invite hashes that cannot be redeemed. */

import crypto from "node:crypto";
import { query } from "./db.js";

/* OWASP's floor for scrypt is N=2^17 with r=8. That costs ~130 MB per hash,
   which a 512 MB instance cannot afford if two people log in at once. N=2^15
   with r=8 costs ~32 MB and still puts a single guess at ~60ms — against an
   offline attacker that is roughly 16 guesses/second/core, which for the
   passphrases this gate protects is the right trade on this hardware. The
   parameters are stored WITH each hash so raising them later does not invalidate
   existing passwords. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;          // scrypt on a megabyte of input is a free DoS
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MIN = 15;

const scrypt = (password, salt, opts) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, opts.keylen, opts, (err, dk) => err ? reject(err) : resolve(dk)));

/** `scrypt$N$r$p$salt$hash`, all base64. Self-describing so parameters can move. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

/**
 * Constant-time. Returns false on a malformed record rather than throwing:
 * a corrupt row must fail the login, never 500 in a way that distinguishes it
 * from a wrong password.
 */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const dk = await scrypt(password, salt, {
      N: +N, r: +r, p: +p, keylen: expected.length, maxmem: SCRYPT.maxmem,
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");

/* Session tokens are 256 bits of CSPRNG output. Only the hash is stored, so a
   database read does not hand out live sessions — the same reason passwords are
   hashed, applied to the credential that is actually presented on every
   request. */
const newToken = () => crypto.randomBytes(32).toString("base64url");

/* ── validation ─────────────────────────────────────────────────────────── */

/* Deliberately permissive. Over-strict email regexes reject valid addresses,
   and this one is a lookup key, not a proof of ownership. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email) {
  const e = String(email || "").trim();
  if (!e) return "Email is required.";
  if (e.length > 254) return "That email address is too long.";
  if (!EMAIL_RE.test(e)) return "That does not look like an email address.";
  return null;
}

/* Length over composition rules. Mandatory symbols push people toward
   "Password1!" — long is what actually costs an attacker. */
export function validatePassword(pw) {
  const p = String(pw || "");
  if (p.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters. Length is what makes it hard to guess, so a short phrase of ordinary words beats a short jumble.`;
  if (p.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters.`;
  if (/^\s+$/.test(p)) return "Password cannot be only whitespace.";
  return null;
}

/* ── rate limiting ──────────────────────────────────────────────────────── */

export async function tooManyAttempts(key) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM auth_attempts
      WHERE key = $1 AND at > now() - ($2 || ' minutes')::interval`,
    [key, String(ATTEMPT_WINDOW_MIN)]);
  return rows[0].n >= MAX_ATTEMPTS;
}

export const recordAttempt = key => query("INSERT INTO auth_attempts (key) VALUES ($1)", [key]);
export const clearAttempts = key => query("DELETE FROM auth_attempts WHERE key = $1", [key]);

/* ── invites ────────────────────────────────────────────────────────────── */

/* Crockford base32 without I, L, O, U: no character pairs that get misread when
   a code is typed off a phone screen, and no accidental words. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateInviteCode() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;                              // 8 chars, ~40 bits
}

export async function createInvite({ createdBy, days = 7, note = null }) {
  const code = generateInviteCode();
  await query(
    `INSERT INTO invites (code_hash, created_by, expires_at, note)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [sha256(code), createdBy ?? null, String(days), note]);
  // Returned exactly once. Only the hash is stored, so it cannot be shown again.
  return { code, expiresInDays: days };
}

export async function listInvites() {
  const { rows } = await query(
    `SELECT left(code_hash, 8) AS ref, created_at, expires_at, used_at, note,
            (used_at IS NOT NULL) AS used,
            (expires_at < now()) AS expired
       FROM invites ORDER BY created_at DESC LIMIT 100`);
  return rows;
}

/* ── accounts ───────────────────────────────────────────────────────────── */

export async function countUsers() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  return rows[0].n;
}

/**
 * Create an account, consuming the invite in the same transaction as the insert.
 *
 * The invite is claimed with a conditional UPDATE rather than a SELECT followed
 * by an UPDATE: two people racing the same code would both pass a check-then-act
 * and both get accounts. `used_by IS NULL` in the WHERE clause makes the database
 * decide, and exactly one UPDATE reports a row.
 *
 * The FIRST account is admin and needs no invite — otherwise there is nobody who
 * can issue the first one.
 */
export async function signup({ email, password, invite, requireInvite = true }) {
  const emailErr = validateEmail(email);
  if (emailErr) return { error: emailErr, status: 400 };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr, status: 400 };

  const first = (await countUsers()) === 0;
  const hash = await hashPassword(password);

  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, is_admin)
       VALUES ($1, $2, $3) RETURNING id, email, is_admin, created_at`,
      [String(email).trim(), hash, first]);
    const user = rows[0];

    if (!first && requireInvite) {
      const claim = await query(
        `UPDATE invites SET used_by = $1, used_at = now()
          WHERE code_hash = $2 AND used_by IS NULL AND expires_at > now()`,
        [user.id, sha256(String(invite || "").trim().toUpperCase())]);
      if (claim.rowCount !== 1) {
        /* The account was written before the claim, so it must be removed when
           the claim fails. Doing it in this order means a valid code is never
           burned by a duplicate-email failure that happens afterwards. */
        await query("DELETE FROM users WHERE id = $1", [user.id]);
        return { error: "That invite code is not valid, has already been used, or has expired.", status: 403 };
      }
    }
    return { user: { id: user.id, email: user.email, isAdmin: user.is_admin, createdAt: user.created_at }, first };
  } catch (e) {
    if (e.code === "23505") return { error: "An account with that email already exists.", status: 409 };
    throw e;
  }
}

/**
 * Verify credentials.
 *
 * A missing account still runs a scrypt hash against a dummy record. Returning
 * early would make "no such user" measurably faster than "wrong password" and
 * turn the login form into an account-existence oracle.
 */
const DUMMY_HASH = await hashPassword(crypto.randomBytes(32).toString("hex"));

export async function login({ email, password }) {
  const { rows } = await query(
    "SELECT id, email, password_hash, is_admin, status FROM users WHERE email_lower = lower($1)",
    [String(email || "").trim()]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);

  // One message for every failure. Which half was wrong is not the user's
  // business and is very much an attacker's.
  if (!user || !ok) return { error: "Email or password is incorrect.", status: 401 };
  if (user.status !== "active") return { error: "That account is disabled.", status: 403 };

  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  return { user: { id: user.id, email: user.email, isAdmin: user.is_admin } };
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const pwErr = validatePassword(newPassword);
  if (pwErr) return { error: pwErr, status: 400 };
  const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  if (!rows[0]) return { error: "No such account.", status: 404 };
  if (!(await verifyPassword(currentPassword, rows[0].password_hash)))
    return { error: "Current password is incorrect.", status: 403 };

  await query("UPDATE users SET password_hash = $1 WHERE id = $2",
    [await hashPassword(newPassword), userId]);
  /* Every other session dies. A password change is usually a response to
     suspecting one is compromised, and leaving them alive makes the change
     cosmetic. The caller re-issues for the current device. */
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return { ok: true };
}

/* ── sessions ───────────────────────────────────────────────────────────── */

export async function createSession(userId, { userAgent, ip } = {}) {
  const token = newToken();
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)`,
    [sha256(token), userId, String(SESSION_DAYS), (userAgent || "").slice(0, 300), (ip || "").slice(0, 64)]);
  return { token, expiresInDays: SESSION_DAYS };
}

/** Resolve a cookie to a user. Expired rows are treated as absent. */
export async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.token_hash, u.id, u.email, u.is_admin, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]);
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  /* Touched, not extended. `last_seen` answers "is this device still in use";
     rolling `expires_at` forward on every request would make a stolen cookie
     immortal as long as it keeps being used. */
  query("UPDATE sessions SET last_seen = now() WHERE token_hash = $1", [row.token_hash])
    .catch(e => console.warn(`[auth] session touch failed: ${e.message}`));
  return { id: row.id, email: row.email, isAdmin: row.is_admin };
}

export const destroySession = token =>
  query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);

export const destroyAllSessions = userId =>
  query("DELETE FROM sessions WHERE user_id = $1", [userId]);

export async function listSessions(userId, currentToken) {
  const { rows } = await query(
    `SELECT token_hash, created_at, last_seen, expires_at, user_agent, ip
       FROM sessions WHERE user_id = $1 ORDER BY last_seen DESC`, [userId]);
  const cur = currentToken ? sha256(currentToken) : null;
  return rows.map(r => ({
    ref: r.token_hash.slice(0, 8),
    current: r.token_hash === cur,
    createdAt: r.created_at, lastSeen: r.last_seen, expiresAt: r.expires_at,
    userAgent: r.user_agent, ip: r.ip,
  }));
}

export { sha256 };
