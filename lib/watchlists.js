/* Named watchlists. The scan set is the union of every group, so a symbol in
   any list is watched exactly once; groups are how the user slices the view,
   not what the engine iterates.

   The old flat universe file migrates into a "Default" group on first load, and
   the /universe endpoints keep operating on that group, so nothing that spoke
   the old shape breaks. */

export const DEFAULT_GROUP = "Default";
const NAME_MAX = 40;

/** Group names are user-facing labels, not symbols — allow spaces, keep it
    printable, and stop it being long enough to break a layout. */
export function cleanName(raw) {
  const n = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return /^[\w &().\-]+$/.test(n) ? n : "";
}

/** Accepts the legacy flat array or the grouped shape, and always returns the
    grouped shape with at least one group. `clean` is the caller's symbol
    normaliser, so there is still exactly one of those in the codebase. */
export function migrate(raw, clean) {
  if (Array.isArray(raw)) return { [DEFAULT_GROUP]: clean(raw) };
  const groups = raw && typeof raw === "object" ? raw.groups || raw : {};
  const out = {};
  for (const [name, syms] of Object.entries(groups)) {
    const n = cleanName(name);
    if (n) out[n] = clean(syms);
  }
  return Object.keys(out).length ? out : { [DEFAULT_GROUP]: [] };
}

/** Every symbol under watch, deduped, first-appearance order. */
export function union(groups, clean) {
  return clean(Object.values(groups).flat());
}

/** Which lists a symbol belongs to — attached to each snapshot row so the
    dashboard can filter without asking a second endpoint. */
export function groupsFor(groups, symbol) {
  return Object.entries(groups).filter(([, syms]) => syms.includes(symbol)).map(([name]) => name);
}

export const counts = groups =>
  Object.fromEntries(Object.entries(groups).map(([name, syms]) => [name, syms.length]));
