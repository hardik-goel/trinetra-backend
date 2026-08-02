/* The morning brief — one object answering "what do I need to know today", and
   a compact Telegram version of it at 08:45 IST.

   Ordering is deliberate: exit signals first, because they concern money
   already at risk and are time-critical, then new signals, then IPOs closing,
   then events. A brief that leads with an exciting new idea while a stop was
   breached overnight has its priorities backwards.

   Silence must always mean breakage, never emptiness — so an empty brief is
   still sent, saying it is empty. */

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const DAY_MS = 86_400_000;
const TG_LIMIT = 4096;

export const istNow = (ms = Date.now()) => new Date(ms + IST_OFFSET_MS);
export const istMinutes = (ms = Date.now()) => {
  const d = istNow(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const isWeekday = (ms = Date.now()) => {
  const day = istNow(ms).getUTCDay();
  return day !== 0 && day !== 6;
};

/** Signals since the previous close: anything fired after 15:30 IST yesterday. */
function sinceLastClose(signals, now = Date.now()) {
  const d = istNow(now);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // Before today's open, "since last close" reaches back to yesterday's close.
  const daysBack = mins < 15 * 60 + 30 ? 1 : 0;
  const cutoff = new Date(d);
  cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
  cutoff.setUTCHours(10, 0, 0, 0); // 15:30 IST == 10:00 UTC
  return signals.filter(s => s.firedAt >= cutoff.getTime() - IST_OFFSET_MS);
}

export function build({ signals, holdings, exitSignals, events, concentration, ipos, dataHealth, profiles, now = Date.now() }) {
  const fresh = sinceLastClose(signals, now);

  const byProfile = {};
  for (const s of fresh) {
    const id = s.profileId || "unknown";
    (byProfile[id] ||= []).push(s);
  }
  // Conviction ranking: criteria met first, then confidence, then volume.
  for (const id of Object.keys(byProfile)) {
    byProfile[id].sort((a, b) =>
      (b.count ?? 0) - (a.count ?? 0) ||
      (b.confidence?.score ?? 0) - (a.confidence?.score ?? 0) ||
      (b.volX ?? 0) - (a.volX ?? 0));
    byProfile[id] = byProfile[id].map(s => ({
      ...s,
      profileName: profiles?.[s.profileId]?.name || s.profileId,
    }));
  }

  return {
    generatedAt: now,
    newSignals: { total: fresh.length, byProfile },
    holdings: holdings.map(h => ({
      symbol: h.symbol,
      entryPrice: h.entryPrice,
      unrealisedPct: h.mtm?.unrealisedPct ?? null,
      daysHeld: h.mtm?.daysHeld ?? null,
      exitSignals: exitSignals.filter(e => e.holdingId === h.id),
    })),
    exitSignals,
    ipos,
    events,
    concentration,
    dataHealth,
  };
}

/* ── Telegram rendering ───────────────────────────────────────────────────
   Compact, ordered by what costs money soonest, truncated at the API limit
   rather than silently dropped. */

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderTelegram(brief) {
  const L = [];
  const d = istNow(brief.generatedAt);
  L.push(`👁 <b>TRINETRA — morning brief</b>`);
  L.push(`<i>${d.toISOString().slice(0, 10)} · ${brief.dataHealth?.delayed ? "delayed feed" : "live feed"}</i>`);

  const exits = brief.exitSignals || [];
  if (exits.length) {
    L.push(`\n<b>⚠ Exit signals (${exits.length})</b> — money already at risk`);
    for (const e of exits.slice(0, 6)) {
      L.push(`• <b>${esc(e.symbol)}</b> — ${esc(e.headline)} [${e.severity}]`);
      L.push(`  ${esc(e.reasoning)}`);
      L.push(`  <i>${esc(e.suggestedAction)} — the call is yours.</i>`);
    }
    if (exits.length > 6) L.push(`  …and ${exits.length - 6} more in the app.`);
  }

  const ns = brief.newSignals || { total: 0, byProfile: {} };
  if (ns.total) {
    L.push(`\n<b>New signals (${ns.total})</b>`);
    for (const [, list] of Object.entries(ns.byProfile)) {
      for (const s of list.slice(0, 5)) {
        const c = s.confidence;
        const p = s.potential;
        const bits = [
          `<b>${esc(s.symbol)}</b> · ${esc(s.profileName || "")}`,
          c ? `conf ${c.score} (${c.band})` : null,
          p?.movedAlreadyPct != null ? `moved ${p.movedAlreadyPct > 0 ? "+" : ""}${p.movedAlreadyPct}%` : null,
          p?.remainingPct ? `est +${p.remainingPct.low}–${p.remainingPct.high}% left` : null,
          s.exits?.safe ? `safe +${s.exits.safe.pct}%` : null,
          s.exits?.stop ? `stop ${s.exits.stop.pct}%` : null,
        ].filter(Boolean);
        L.push(`• ${bits.join(" · ")}`);
        if (p?.exhausted) L.push(`  <i>Typical move already captured — little left by this estimate.</i>`);
        if (s.eventWarning) L.push(`  <i>${esc(s.eventWarning)}</i>`);
        if (s.lagDisclosure) L.push(`  <i>${esc(s.lagDisclosure)}</i>`);
      }
    }
  }

  if (brief.ipos?.length) {
    L.push(`\n<b>IPOs closing</b>`);
    for (const i of brief.ipos.slice(0, 5)) L.push(`• ${esc(i.name)} — ${esc(i.verdict || "no verdict")} (closes ${esc(i.closeDate || "soon")})`);
  }

  if (brief.events?.length) {
    L.push(`\n<b>Events within 3 sessions</b>`);
    for (const e of brief.events.slice(0, 8)) L.push(`• ${esc(e.symbol)} — ${esc(e.event.type)} in ${e.event.daysAway}d`);
  }

  for (const w of brief.concentration?.warnings || []) L.push(`\n⚠ ${esc(w)}`);

  if (!exits.length && !ns.total && !brief.ipos?.length && !brief.events?.length) {
    L.push(`\nAll quiet — no signals, no exits, no events. The scan ran; there was simply nothing to report.`);
  }

  const health = brief.dataHealth;
  if (health) {
    L.push(`\n<i>Feed: ${esc(health.provider)}${health.delayed ? ` (~${Math.round((health.lagSeconds || 900) / 60)}m delayed)` : ""}, last refresh ${health.ageSeconds}s ago.${health.failures ? ` ${health.failures} source failure(s).` : ""}</i>`);
  }
  L.push(`<i>Decision support, not investment advice.</i>`);

  let text = L.join("\n");
  if (text.length > TG_LIMIT) {
    text = text.slice(0, TG_LIMIT - 120).replace(/\n[^\n]*$/, "") + `\n\n<i>…truncated — full brief in the app.</i>`;
  }
  return text;
}
