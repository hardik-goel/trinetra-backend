/* Which browser origins may call this API.

   UI_ORIGIN names production. That is not the whole set of origins the
   dashboard is actually served from: every Vercel deploy gets its own
   hostname, and a pull request or a push to a branch is reachable only at
   that hostname. Listing them is not possible — the per-deploy URLs carry a
   build hash that does not exist until the build runs. So a preview build of
   the dashboard fails CORS against production, on every request, and the
   failure looks like the backend being down rather than a policy decision.

   The fix is to match previews by shape instead of by name. Vercel's preview
   hostnames are <project>-git-<branch>-<scope>.vercel.app for a branch and
   <project>-<hash>-<scope>.vercel.app for a specific deploy, so the project
   slug is a prefix of both. That slug is derived from the .vercel.app entries
   already in UI_ORIGIN — one variable stays the source of truth — and can be
   overridden with UI_ORIGIN_PREVIEW_PREFIX when the production alias is not
   named after the project.

   This is deliberately not a blanket *.vercel.app rule. That would let any
   page anyone deploys to Vercel make credentialed requests against a signed-in
   user's session, which is the whole class of attack the allowlist exists to
   prevent. The prefix keeps it to deploys of this project. */

const parseList = s => (s || "").split(",").map(v => v.trim()).filter(Boolean);

const VERCEL_SUFFIX = ".vercel.app";

/* Production aliases usually carry a random suffix word that previews do not
   share — trinetra-web-zeta is the alias, trinetra-web is the project. Keep
   both, since which one is which cannot be told apart from the hostname. */
function previewPrefixes(origins, explicit) {
  if (explicit) return parseList(explicit);
  const out = new Set();
  for (const o of origins) {
    let host;
    try { host = new URL(o).hostname; } catch { continue; }
    if (!host.endsWith(VERCEL_SUFFIX)) continue;
    const slug = host.slice(0, -VERCEL_SUFFIX.length);
    out.add(slug);
    const root = slug.replace(/-[a-z0-9]+$/, "");
    if (root && root !== slug) out.add(root);
  }
  return [...out];
}

/* Local development runs the dashboard on whatever port is free. Enumerating
   3000, 3001, 5173 in UI_ORIGIN is noise, so one loopback entry opts the whole
   loopback interface in. A deployed instance whose UI_ORIGIN names no loopback
   origin gets none of this. */
const isLoopback = o => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);

/** Returns the value for the cors `origin` option: a matcher function that
 *  accepts the configured origins plus previews of the same Vercel project. */
export function buildCorsOrigin(uiOrigin, env = process.env) {
  const allow = parseList(uiOrigin);
  const exact = new Set(allow);
  const prefixes = previewPrefixes(allow, env.UI_ORIGIN_PREVIEW_PREFIX);
  const allowLoopback = allow.some(isLoopback);
  const extra = env.UI_ORIGIN_REGEX ? new RegExp(env.UI_ORIGIN_REGEX) : null;

  const allowed = origin => {
    if (exact.has(origin)) return true;
    if (allowLoopback && isLoopback(origin)) return true;
    if (extra && extra.test(origin)) return true;
    if (!prefixes.length) return false;
    let host;
    try { host = new URL(origin).hostname; } catch { return false; }
    if (!host.endsWith(VERCEL_SUFFIX)) return false;
    const slug = host.slice(0, -VERCEL_SUFFIX.length);
    return prefixes.some(p => slug === p || slug.startsWith(`${p}-`));
  };

  const matcher = (origin, cb) => {
    /* No Origin header at all: curl, a health check, a server-to-server call.
       CORS is a browser rule and there is no browser here to protect. */
    if (!origin) return cb(null, true);
    if (allowed(origin)) return cb(null, true);
    /* Resolve false rather than passing an Error. An Error becomes a 500 with
       no CORS headers, which reads as the backend crashing; false sends the
       normal response without the headers, and the browser reports it as the
       CORS refusal it is. The log line is the only place the real reason
       appears, so it names the origin. */
    console.warn(`[cors] blocked ${origin} — not in UI_ORIGIN and not a preview of ${prefixes.join("/") || "any known project"}`);
    cb(null, false);
  };
  matcher.describe = () =>
    `restricted to ${allow.join(", ")}` +
    (prefixes.length ? ` · previews of ${prefixes.join(", ")}` : "") +
    (allowLoopback ? " · any localhost port" : "") +
    (extra ? ` · matching ${extra}` : "");
  return matcher;
}
