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
/* Not defaulted to "main". GitHub's default for new repos is main, but plenty of
   accounts and templates still produce master — this project's own repos do — and
   writing to a branch that does not exist fails on every single call with an error
   that reads like a permissions problem. So: use DATA_BRANCH when set, otherwise
   ask the repo what its default branch actually is. */
const BRANCH_ENV = (process.env.DATA_BRANCH || "").trim();
let BRANCH = BRANCH_ENV || "main";
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
  lastError: null, lastStatus: null, pushes: 0, failures: 0,
  /* Failures SINCE the last success. `failures` is a lifetime counter and must
     not drive the health state: once a service has failed one write, that number
     never returns to zero, so any later moment with a file queued would report
     degraded forever. The health question is "is it working now", not "has it
     ever failed". */
  failuresSinceSuccess: 0,
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
    /* The status travels on the error rather than being recovered by regex from
       the message. A URL or a response body can contain three digits that look
       like a status, and the hint the user acts on must not hinge on that. */
    const err = new Error(`GitHub ${method} ${urlPath} → ${r.status} ${text.slice(0, 180)}`);
    err.status = r.status;
    throw err;
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

  /* Resolve the branch first. A wrong branch fails every read and write with a
     404, which is indistinguishable from a bad token unless you know to look. */
  if (!BRANCH_ENV) {
    try {
      const repo = await gh("GET", `/repos/${REPO}`);
      if (repo?.notFound) {
        state.lastError = `repo ${REPO} not found — check DATA_REPO, and that the token can see it (a fine-grained token must list this repo under "Only select repositories")`;
        console.warn(`[remote] ${state.lastError}`);
        return { enabled: true, adopted: [], skipped: [], seeded: [], error: state.lastError };
      }
      if (repo?.default_branch && repo.default_branch !== BRANCH) {
        console.log(`[remote] default branch is "${repo.default_branch}", not "${BRANCH}" — using it`);
        BRANCH = repo.default_branch;
      }
      state.branchResolved = BRANCH;
    } catch (e) {
      state.lastError = `could not read repo metadata: ${e.message}`;
      console.warn(`[remote] ${state.lastError}`);
    }
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
      state.lastStatus = e.status ?? null;
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
      // A success clears the alarm. Anything still queued is simply pending.
      state.failuresSinceSuccess = 0;
      state.lastError = null;
      state.lastStatus = null;
    } catch (e) {
      failed.push(name);
      state.dirty.add(name);      // keep it dirty so the next flush retries
      state.failures++;
      state.lastError = e.message;
      state.lastStatus = e.status ?? null;
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
function hintFor(code) {
  switch (code) {
    case 401:
      return "Token not accepted at all — expired, revoked, or mistyped. Generate a new fine-grained PAT and update DATA_REPO_TOKEN.";
    case 403:
      return "Token authenticates but is not allowed to do this. It is a permissions problem, NOT expiry: set Repository permissions → Contents: Read and write, and make sure this repo is in the token's \"Only select repositories\" list. On an organisation repo the token may also need owner approval.";
    case 404:
      return "Repo or path not found. Check DATA_REPO is exactly \"owner/name\". A fine-grained token that cannot see a repo gets 404 rather than 403, so this can also mean the repo is missing from the token's selected list.";
    case 409:
    case 422:
      return "Write conflict — something else changed the file. This retries itself; if it persists, the branch may be protected.";
    case 429:
      return "Rate limited by GitHub. Writes will resume on their own; raise DATA_FLUSH_MS if it recurs.";
    default:
      return code ? `GitHub returned ${code}. The full response is in lastError.` : null;
  }
}

export function status() {
  if (!state.enabled) {
    return {
      mode: "ephemeral", durable: false,
      detail: "No durable store configured. Everything in data/ — signal history, the alert ledger, hand-entered analyst calls, your edited universe and criteria — is lost on the next redeploy.",
      fix: "Set DATA_REPO (owner/name of a private repo) and DATA_REPO_TOKEN (fine-grained PAT with Contents: read and write on that repo only).",
    };
  }
  /* Degraded means writes are failing NOW: either nothing has ever been written,
     or something has failed since the last success. A queued file on its own is
     not degraded — it is a write that has not happened yet, which is the normal
     state between a change and the next flush. */
  const stale = !state.lastPushAt || state.failuresSinceSuccess > 0;
  return {
    mode: stale ? "degraded" : "durable",
    durable: !stale,
    repo: REPO, branch: BRANCH, branchSource: BRANCH_ENV ? "DATA_BRANCH" : "repo default",
    lastPullAt: state.lastPullAt, lastPushAt: state.lastPushAt,
    pushes: state.pushes, failures: state.failures,
    failuresSinceSuccess: state.failuresSinceSuccess,
    pendingFiles: [...state.dirty],
    adoptedAtBoot: state.adopted,
    lastError: state.lastError,
    /* A raw "404" or "403" from the API tells the user nothing about which of the
       four setup steps they got wrong. Each one has a distinct, actionable cause. */
    /* Branched on the status code, because 401 and 403 mean different things and
       the wrong hint sends someone to regenerate a token that authenticates
       perfectly well. 401 is "we do not know who you are"; 403 is "we know, and
       you may not do this". */
    hint: !state.lastError ? null : hintFor(state.lastStatus),
    detail: stale
      ? (state.lastPushAt
          ? "Writes to GitHub are failing. Changes since the last successful write exist only on this instance's disk and will be lost on redeploy."
          : "Configured, but nothing has ever been written to GitHub. Nothing is durable yet.")
      : state.dirty.size
        ? "Durable. A few changes are queued and will be committed within seconds."
        : "Local disk is the working copy; every change is committed to the repo within seconds.",
  };
}

/**
 * The safe-to-publish subset, for /health on a public URL.
 *
 * The user needs to know WHETHER their data is durable. They do not need — and a
 * passer-by should not get — the repo name or the raw GitHub error text, which
 * can echo back request detail. Same reasoning as masking the Telegram token in
 * /config: the state is public, the coordinates are not.
 */
export function publicStatus() {
  const s = status();
  return {
    mode: s.mode, durable: s.durable, detail: s.detail,
    ...(s.fix ? { fix: s.fix } : {}),
    ...(s.mode !== "ephemeral" ? { pendingCount: s.pendingFiles.length, lastPushAt: s.lastPushAt } : {}),
  };
}

/**
 * Print the diagnosis to the process log when storage is not healthy.
 *
 * Reading `lastError` over HTTP requires the backup token, which means putting a
 * credential on a command line to answer "why is my backup broken" — and a token
 * pasted into a shell is a token in history, in a scrollback buffer, and
 * sometimes in a chat log. That already happened once here.
 *
 * The failure text is not sensitive; the token is. So the deploy log answers it
 * with no credential at all. The repo name appears here because process logs are
 * already private to whoever can deploy the service — the same reasoning does not
 * extend to a public HTTP response, which is why /health still omits it.
 */
export function logDiagnosis() {
  const s = status();
  if (s.mode === "durable") return;
  console.warn(`[storage] ${s.mode.toUpperCase()} — ${s.detail}`);
  if (s.mode === "ephemeral") { console.warn(`[storage] fix: ${s.fix}`); return; }
  console.warn(`[storage] repo=${s.repo} branch=${s.branch} (${s.branchSource}) failures=${s.failures} pending=${s.pendingFiles.length}`);
  if (s.lastError) console.warn(`[storage] lastError: ${s.lastError}`);
  if (s.hint) console.warn(`[storage] hint: ${s.hint}`);
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
