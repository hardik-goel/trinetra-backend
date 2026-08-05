/* Durable storage on a free tier.

   Render's free plan has no persistent disk: every redeploy wipes data/, taking
   the signal history, the alert ledger, the hand-typed analyst calls, the edited
   universe and the tuned criteria with it. This module keeps a copy in a private
   GitHub repo through the Contents API, so a wipe costs nothing.

   Three deliberate choices:

   1. **Local disk stays the working copy.** Every read is a local read; nothing
      pays a network round-trip. GitHub is written to, not read from, except once
      at boot. A slow or rate-limited API can never slow the scan loop.

   2. **Writes are debounced, not immediate.** signal_history.json is written on
      every scan; one commit per write would be thousands of commits a day. Dirty
      files coalesce into a single commit per flush window.

   3. **It fails loudly, not silently.** If GitHub is unreachable the app runs
      exactly as it does today — but `status()` says `degraded` and /health
      reports it. A store that quietly stops persisting is worse than no store,
      because the user would trust it.

   Every write is a commit, so the version history IS the backup history: when a
   symbol was added is answerable, and `git revert` is a restore.

   Secrets never leave the process. config.json holds the Telegram token; the
   sanitiser strips it before the file is ever encoded, the same way /backup does. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");

const REPO = (process.env.DATA_REPO || "").trim();            // "owner/name"
const TOKEN = (process.env.DATA_REPO_TOKEN || "").trim();
const BRANCH = (process.env.DATA_BRANCH || "main").trim();
const FLUSH_MS = Math.max(2000, +(process.env.DATA_FLUSH_MS || 10_000));

// Overridable so the whole path can be exercised against a stub rather than
// only ever being tested in production against the user's real data.
const API = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");

/* What gets kept. `dir: "root"` covers the two files that live beside index.js
   rather than in data/ — the edited universe and the tuned criteria, which are
   exactly what the user asked not to lose. */
const TRACKED = [
  { name: "signal_history.json", dir: "data" },
  { name: "paper_trades.json", dir: "data" },
  { name: "ipo_applications.json", dir: "data" },
  { name: "holdings.json", dir: "data" },
  { name: "events.json", dir: "data" },
  { name: "alert_ledger.json", dir: "data" },
  { name: "analyst_calls.json", dir: "data" },
  { name: "market_holidays.json", dir: "data" },
  { name: "universe.runtime.json", dir: "root" },
  /* A cache, but an expensive one: re-scraping it is ~1s per symbol against a
     host that rate-limits, so a 300-name universe pays six minutes on every
     redeploy and may simply be refused. Staleness is still enforced on read, so
     keeping it never serves stale numbers — it only avoids refetching what has
     not changed. */
  { name: "fundamentals.cache.json", dir: "root" },
  { name: "config.json", dir: "root", sanitize: stripSecrets },
];

const byName = Object.fromEntries(TRACKED.map(t => [t.name, t]));
const localPath = t => path.join(t.dir === "root" ? ROOT : DATA_DIR, t.name);

/* The credentials come from the environment on every boot, so they do not need
   to survive in a file — and a private repo is still one more place a token
   could be read from. Everything else in config is hand-tuned and worth keeping. */
function stripSecrets(data) {
  if (!data || typeof data !== "object") return data;
  const { alerts, ...rest } = data;
  return { ...rest, alerts: { ...alerts, telegram: { on: !!alerts?.telegram?.on } } };
}

export const configured = () => !!(REPO && TOKEN);

const state = {
  enabled: configured(),
  lastPullAt: null, lastPushAt: null,
  lastError: null, pushes: 0, failures: 0,
  adopted: [],            // files taken from the remote at boot
  shas: {},               // path -> last known blob sha
  dirty: new Set(),
  flushing: false,
  timer: null,
};

async function gh(method, urlPath, body) {
  const r = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`GitHub ${method} ${urlPath} → ${r.status} ${text.slice(0, 180)}`);
  }
  return r.json();
}

const b64encode = obj => Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
const b64decode = s => JSON.parse(Buffer.from(String(s).replace(/\n/g, ""), "base64").toString("utf8"));

async function getRemote(name) {
  const j = await gh("GET", `/repos/${REPO}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(BRANCH)}`);
  if (j.notFound) return null;
  state.shas[name] = j.sha;
  return { data: b64decode(j.content), sha: j.sha };
}

async function putRemote(name, data, message) {
  const body = { message, content: b64encode(data), branch: BRANCH };
  if (state.shas[name]) body.sha = state.shas[name];
  try {
    const j = await gh("PUT", `/repos/${REPO}/contents/${encodeURIComponent(name)}`, body);
    state.shas[name] = j.content?.sha || state.shas[name];
    return true;
  } catch (e) {
    /* A stale sha means someone else wrote it — another instance, or the user on
       github.com. Re-read the current sha and try once more; last write wins,
       which is correct here because the local copy is the one the user has been
       editing this session. */
    if (/409|422/.test(e.message)) {
      const cur = await getRemote(name).catch(() => null);
      if (cur) {
        const retry = { message, content: b64encode(data), branch: BRANCH, sha: cur.sha };
        const j = await gh("PUT", `/repos/${REPO}/contents/${encodeURIComponent(name)}`, retry);
        state.shas[name] = j.content?.sha || state.shas[name];
        return true;
      }
    }
    throw e;
  }
}

const readLocal = t => {
  try { return JSON.parse(fs.readFileSync(localPath(t), "utf8")); } catch { return null; }
};

const writeLocal = (t, data) => {
  const target = localPath(t);
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
};

/**
 * Boot: adopt anything the remote has that this disk does not.
 *
 * The rule is deliberately conservative — a remote file is adopted only when the
 * local one is ABSENT. That is the wipe case, which is the whole point. It will
 * never overwrite a local file that exists, because a running instance's local
 * copy is newer than anything it has not yet flushed, and silently replacing a
 * live trade log with an older snapshot is a far worse failure than a stale
 * remote.
 *
 * Returns the list of adopted filenames so the caller can reload the modules
 * holding them in memory.
 */
export async function bootstrap() {
  if (!state.enabled) {
    state.lastError = "DATA_REPO / DATA_REPO_TOKEN not set";
    return { enabled: false, adopted: [], reason: state.lastError };
  }
  const adopted = [];
  const skipped = [];
  const seeded = [];
  for (const t of TRACKED) {
    try {
      const local = readLocal(t);
      const remote = await getRemote(t.name);
      if (!remote) {
        /* Nothing kept remotely yet. If this disk has the file, seed it — most
           of these are written only when they change, so an alert ledger or a
           set of hand-typed analyst calls would otherwise sit on an ephemeral
           disk indefinitely, never touched and therefore never backed up, until
           the redeploy that deletes it. */
        if (local !== null) { seeded.push(t.name); markDirty(t.name); }
        continue;
      }
      if (local !== null) { skipped.push(t.name); continue; }  // local wins, always
      writeLocal(t, remote.data);
      adopted.push(t.name);
    } catch (e) {
      state.failures++;
      state.lastError = e.message;
      console.warn(`[remote] pull ${t.name}: ${e.message}`);
    }
  }
  state.lastPullAt = Date.now();
  state.adopted = adopted;
  if (adopted.length) console.log(`[remote] adopted from ${REPO}: ${adopted.join(", ")}`);
  if (seeded.length) console.log(`[remote] seeding ${REPO} with local-only file(s): ${seeded.join(", ")}`);
  if (!adopted.length && !seeded.length) console.log(`[remote] in sync — ${skipped.length} tracked file(s) already present on both sides`);
  if (seeded.length) flush("initial seed").catch(() => {});
  return { enabled: true, adopted, skipped, seeded };
}

/** Mark a file changed. Cheap and synchronous — the flush happens later. */
export function markDirty(name) {
  if (!state.enabled || !byName[name]) return;
  state.dirty.add(name);
  if (state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; flush().catch(() => {}); }, FLUSH_MS);
  state.timer.unref?.();
}

/** Push every dirty file. Safe to call directly; the debounce is an optimisation. */
export async function flush(reason = "scheduled") {
  if (!state.enabled || state.flushing || state.dirty.size === 0) return { pushed: [] };
  state.flushing = true;
  const names = [...state.dirty];
  state.dirty.clear();
  const pushed = [], failed = [];
  for (const name of names) {
    const t = byName[name];
    try {
      const data = readLocal(t);
      if (data === null) continue;
      await putRemote(name, t.sanitize ? t.sanitize(data) : data, `trinetra: ${name} (${reason})`);
      pushed.push(name);
      state.pushes++;
    } catch (e) {
      failed.push(name);
      state.dirty.add(name);      // keep it dirty so the next flush retries
      state.failures++;
      state.lastError = e.message;
      console.warn(`[remote] push ${name}: ${e.message}`);
    }
  }
  state.flushing = false;
  if (pushed.length) state.lastPushAt = Date.now();
  return { pushed, failed };
}

/**
 * What the user needs to know, in the words they need to hear it in.
 *
 * "ephemeral" is not an error state — it is the honest name for what the service
 * is when nothing is configured, and it is worth saying out loud rather than
 * leaving someone to discover it on the redeploy that loses their data.
 */
export function status() {
  if (!state.enabled) {
    return {
      mode: "ephemeral", durable: false,
      detail: "No durable store configured. Everything in data/ — signal history, the alert ledger, hand-entered analyst calls, your edited universe and criteria — is lost on the next redeploy.",
      fix: "Set DATA_REPO (owner/name of a private repo) and DATA_REPO_TOKEN (fine-grained PAT with Contents: read and write on that repo only).",
    };
  }
  const stale = state.lastError && (!state.lastPushAt || state.failures > 0 && state.dirty.size > 0);
  return {
    mode: stale ? "degraded" : "durable",
    durable: !stale,
    repo: REPO, branch: BRANCH,
    lastPullAt: state.lastPullAt, lastPushAt: state.lastPushAt,
    pushes: state.pushes, failures: state.failures,
    pendingFiles: [...state.dirty],
    adoptedAtBoot: state.adopted,
    lastError: state.lastError,
    detail: stale
      ? "Configured, but the last write to GitHub failed. Changes since then exist only on this instance's disk and will be lost on redeploy."
      : "Local disk is the working copy; every change is committed to the repo within seconds.",
  };
}

/** Flush before the process goes away. Render sends SIGTERM on redeploy. */
export function installShutdownFlush() {
  if (!state.enabled) return;
  let done = false;
  const bye = async (sig) => {
    if (done) return;
    done = true;
    console.log(`[remote] ${sig} — flushing ${state.dirty.size} pending file(s)`);
    try { await flush(`${sig} flush`); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => bye("SIGTERM"));
  process.on("SIGINT", () => bye("SIGINT"));
}

export const trackedFiles = () => TRACKED.map(t => t.name);
