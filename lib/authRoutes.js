/* The HTTP surface for accounts: cookies, guards, CSRF, and the routes.

   Two decisions shape everything here.

   COOKIES, NOT BEARER TOKENS. The dashboard is a browser app on a different
   origin from the API, so the token has to live somewhere. `localStorage` is
   readable by any script that gets onto the page, and one bad dependency then
   owns every account. An httpOnly cookie is not readable by script at all. The
   cost is that cookies are sent automatically, which is what CSRF exploits — so
   that has to be closed explicitly, below.

   FAIL CLOSED. Every guard here denies when it cannot prove the request is
   authorised. A guard that allows on error is not a guard; it is a comment. */

import express from "express";
import crypto from "node:crypto";
import * as db from "./db.js";
import * as auth from "./auth.js";

const COOKIE = "trinetra_session";
const CSRF_COOKIE = "trinetra_csrf";

/* Cross-site by construction: the dashboard is on Vercel, the API on Render.
   SameSite=None is REQUIRED for the cookie to be sent at all, and browsers only
   accept None together with Secure. That combination is exactly what CSRF needs,
   so the double-submit token below is not optional decoration — it is the thing
   standing in for SameSite. When the two share an origin, Lax is strictly
   better and is used instead. */
const CROSS_SITE = process.env.COOKIE_CROSS_SITE !== "false";
const cookieOpts = maxAgeDays => ({
  httpOnly: true,
  secure: true,
  sameSite: CROSS_SITE ? "none" : "lax",
  path: "/",
  maxAge: maxAgeDays * 86_400_000,
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
});

/* Minimal parser rather than the cookie-parser dependency: one header, one
   split, and nothing else in the app reads cookies. */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/* ── CSRF ─────────────────────────────────────────────────────────────────
   Double-submit: a random value is set in a NON-httpOnly cookie and must be
   echoed in a header. A cross-origin attacker can make the browser send the
   cookie but cannot read it to populate the header, because reading it needs a
   same-origin script. Only state-changing methods are checked; GET must stay
   usable for the dashboard's ordinary reads. */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  // Login and signup have no session to protect and are the routes a user hits
  // before ever receiving a CSRF cookie.
  if (req.path === "/auth/login" || req.path === "/auth/signup") return next();
  if (!readCookie(req, COOKIE)) return next();   // unauthenticated: nothing to forge

  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.get("x-csrf-token");
  const ok = cookie && header && cookie.length === header.length &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  if (!ok) {
    return res.status(403).json({
      error: "CSRF check failed.",
      detail: "State-changing requests must echo the trinetra_csrf cookie in an x-csrf-token header. Read the cookie in the browser and set the header on every non-GET request.",
    });
  }
  next();
}

function issueCsrf(res) {
  const token = crypto.randomBytes(24).toString("base64url");
  res.cookie(CSRF_COOKIE, token, { ...cookieOpts(30), httpOnly: false });
  return token;
}

/* ── guards ───────────────────────────────────────────────────────────────
   `attachUser` never rejects — it only annotates, so a route can decide. */

export async function attachUser(req, _res, next) {
  req.user = null;
  req.sessionToken = null;
  if (!db.enabled || !db.isReady()) return next();
  try {
    const token = readCookie(req, COOKIE) || null;
    if (token) {
      req.user = await auth.resolveSession(token);
      req.sessionToken = token;
    }
  } catch (e) {
    // A database blip must not silently downgrade a request to anonymous with
    // an error nobody sees.
    console.warn(`[auth] session lookup failed: ${e.message}`);
  }
  next();
}

/**
 * Require a signed-in user.
 *
 * In single-user mode there is no database and no accounts, and this passes
 * through — the existing deployment keeps working exactly as it does now.
 * That is a deliberate escape hatch and it is stated on /health, because an
 * auth guard that is silently disabled is worse than no guard at all: it looks
 * protected in the code and is not in production.
 */
export function requireAuth(req, res, next) {
  if (!db.enabled) return next();
  if (!db.isReady()) {
    return res.status(503).json({ error: "The account database is not ready. Try again shortly." });
  }
  if (!req.user) {
    return res.status(401).json({ error: "Sign in to continue.", authRequired: true });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!db.enabled) return next();
  if (!req.user) return res.status(401).json({ error: "Sign in to continue.", authRequired: true });
  if (!req.user.isAdmin) return res.status(403).json({ error: "That action is restricted to the instance owner." });
  next();
}

/* ── routes ─────────────────────────────────────────────────────────────── */

/* Express 4 does not catch rejections from async handlers. An `await` that
   rejects inside a route becomes an unhandled rejection, and Node terminates the
   process — so a single slow Postgres wake-up took the whole instance down
   during testing, which on a free-tier host means a crash plus a cold start for
   everyone. Every async handler goes through this. It is not defensive style;
   without it the auth layer is a liveness bug. */
const wrap = fn => (typeof fn === "function" && fn.constructor?.name === "AsyncFunction")
  ? (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
  : fn;

/* Applied by patching the router's verbs rather than by wrapping each handler at
   its call site. A handler added later would otherwise be unprotected, and the
   failure mode is not a broken route — it is the whole process exiting. */
function safeRouter() {
  const r = express.Router();
  for (const verb of ["get", "post", "patch", "put", "delete"]) {
    const orig = r[verb].bind(r);
    r[verb] = (path, ...handlers) => orig(path, ...handlers.map(wrap));
  }
  return r;
}

export function authRouter() {
  const r = safeRouter();

  const guardDb = (_req, res, next) =>
    db.enabled ? next() : res.status(501).json({
      error: "This instance is running in single-user mode.",
      detail: "Set DATABASE_URL to a Postgres connection string to enable accounts.",
    });

  const clientIp = req =>
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";

  /** What the dashboard asks before rendering anything. */
  r.get("/auth/me", async (req, res) => {
    if (!db.enabled) {
      return res.json({
        authenticated: true, mode: "single-user",
        user: { email: null, isAdmin: true },
        note: "No accounts on this instance — every request is the owner.",
      });
    }
    if (!req.user) return res.status(401).json({ authenticated: false, mode: "multi-user" });
    const csrfToken = issueCsrf(res);
    res.json({ authenticated: true, mode: "multi-user", user: req.user, csrfToken });
  });

  /** Whether signup is even possible, so the UI knows which form to show. */
  r.get("/auth/config", async (_req, res) => {
    if (!db.enabled) return res.json({ mode: "single-user", signupEnabled: false });
    try {
      const users = await auth.countUsers();
      res.json({
        mode: "multi-user",
        signupEnabled: true,
        inviteRequired: users > 0,
        firstRun: users === 0,
        note: users === 0
          ? "No accounts exist yet. The first account created becomes the owner and needs no invite code."
          : "An invite code from the owner is required to sign up.",
        passwordMinLength: 10,
      });
    } catch (e) {
      res.status(503).json({ error: "Account database unavailable.", detail: e.message });
    }
  });

  r.post("/auth/signup", guardDb, async (req, res) => {
    const { email, password, invite } = req.body || {};
    const ipKey = `signup:${clientIp(req)}`;
    try {
      if (await auth.tooManyAttempts(ipKey)) {
        return res.status(429).json({ error: "Too many sign-up attempts. Wait 15 minutes." });
      }
      const out = await auth.signup({ email, password, invite });
      if (out.error) {
        await auth.recordAttempt(ipKey);
        return res.status(out.status || 400).json({ error: out.error });
      }
      const { token } = await auth.createSession(out.user.id, {
        userAgent: req.get("user-agent"), ip: clientIp(req),
      });
      res.cookie(COOKIE, token, cookieOpts(30));
      const csrfToken = issueCsrf(res);
      res.status(201).json({
        user: out.user, csrfToken,
        ...(out.first ? { note: "This is the first account on the instance, so it is the owner and can issue invite codes." } : {}),
      });
    } catch (e) {
      console.warn(`[auth] signup failed: ${e.message}`);
      res.status(500).json({ error: "Could not create the account." });
    }
  });

  r.post("/auth/login", guardDb, async (req, res) => {
    const { email, password } = req.body || {};
    /* Limited on the account AND on the source. Only the first lets one attacker
       lock a victim out; only the second lets a botnet spread a spray thin. */
    const keys = [`login:email:${String(email || "").toLowerCase().trim()}`, `login:ip:${clientIp(req)}`];
    try {
      for (const k of keys) {
        if (await auth.tooManyAttempts(k)) {
          return res.status(429).json({ error: "Too many failed attempts. Wait 15 minutes and try again." });
        }
      }
      const out = await auth.login({ email, password });
      if (out.error) {
        for (const k of keys) await auth.recordAttempt(k);
        return res.status(out.status || 401).json({ error: out.error });
      }
      for (const k of keys) await auth.clearAttempts(k);
      const { token } = await auth.createSession(out.user.id, {
        userAgent: req.get("user-agent"), ip: clientIp(req),
      });
      res.cookie(COOKIE, token, cookieOpts(30));
      const csrfToken = issueCsrf(res);
      res.json({ user: out.user, csrfToken });
    } catch (e) {
      console.warn(`[auth] login failed: ${e.message}`);
      res.status(500).json({ error: "Could not sign in." });
    }
  });

  r.post("/auth/logout", guardDb, async (req, res) => {
    try { if (req.sessionToken) await auth.destroySession(req.sessionToken); } catch {}
    res.clearCookie(COOKIE, { ...cookieOpts(0), maxAge: undefined });
    res.clearCookie(CSRF_COOKIE, { ...cookieOpts(0), httpOnly: false, maxAge: undefined });
    res.json({ ok: true });
  });

  r.post("/auth/password", guardDb, requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    try {
      const out = await auth.changePassword({ userId: req.user.id, currentPassword, newPassword });
      if (out.error) return res.status(out.status || 400).json({ error: out.error });
      // Every session was just dropped, including this one. Re-issue so the
      // person who changed it is not signed out of the device they did it on.
      const { token } = await auth.createSession(req.user.id, {
        userAgent: req.get("user-agent"), ip: clientIp(req),
      });
      res.cookie(COOKIE, token, cookieOpts(30));
      res.json({ ok: true, note: "Password changed. All other devices were signed out." });
    } catch (e) {
      console.warn(`[auth] password change failed: ${e.message}`);
      res.status(500).json({ error: "Could not change the password." });
    }
  });

  r.get("/auth/sessions", guardDb, requireAuth, async (req, res) => {
    res.json({ sessions: await auth.listSessions(req.user.id, req.sessionToken) });
  });

  r.post("/auth/sessions/revoke-all", guardDb, requireAuth, async (req, res) => {
    await auth.destroyAllSessions(req.user.id);
    const { token } = await auth.createSession(req.user.id, {
      userAgent: req.get("user-agent"), ip: clientIp(req),
    });
    res.cookie(COOKIE, token, cookieOpts(30));
    res.json({ ok: true, note: "All other devices signed out." });
  });

  /* ── admin ── */

  r.post("/admin/invites", guardDb, requireAdmin, async (req, res) => {
    const days = Math.min(90, Math.max(1, +(req.body?.days ?? 7)));
    const out = await auth.createInvite({ createdBy: req.user?.id, days, note: req.body?.note ?? null });
    res.status(201).json({
      ...out,
      warning: "This code is shown once and is not recoverable — only its hash is stored. Send it now.",
    });
  });

  r.get("/admin/invites", guardDb, requireAdmin, async (_req, res) => {
    res.json({ invites: await auth.listInvites() });
  });

  r.get("/admin/users", guardDb, requireAdmin, async (_req, res) => {
    const { rows } = await db.query(
      `SELECT id, email, is_admin, status, created_at, last_login_at,
              (SELECT count(*)::int FROM user_universe uu WHERE uu.user_id = users.id) AS symbols
         FROM users ORDER BY created_at`);
    res.json({ users: rows });
  });

  r.patch("/admin/users/:id", guardDb, requireAdmin, async (req, res) => {
    const id = +req.params.id;
    const status = req.body?.status;
    if (!["active", "disabled"].includes(status)) {
      return res.status(400).json({ error: 'status must be "active" or "disabled"' });
    }
    if (id === req.user?.id && status === "disabled") {
      return res.status(400).json({ error: "You cannot disable your own account — that would lock the instance." });
    }
    await db.query("UPDATE users SET status = $1 WHERE id = $2", [status, id]);
    if (status === "disabled") await auth.destroyAllSessions(id);
    res.json({ ok: true });
  });

  return r;
}

export { COOKIE as SESSION_COOKIE, CSRF_COOKIE, readCookie };
