/* Telegram delivery — runs server-side so alerts arrive even with
   every browser closed. Uses the user's own bot (token + chat id). */

export async function notify(tg, sig) {
  if (!tg?.token || !tg?.chatId) return false;
  const arrow = sig.dayChg >= 0 ? "▲" : "▼";
  const p = sig.potential, c = sig.confidence, x = sig.exits;

  // The three numbers the decision actually needs: how much is already gone,
  // how much the evidence says may remain, and how much to trust it.
  const numbers = [
    c ? `conf ${c.score} (${c.band})` : null,
    p?.movedAlreadyPct != null ? `moved ${p.movedAlreadyPct >= 0 ? "+" : ""}${p.movedAlreadyPct}%` : null,
    p?.remainingPct ? `est +${p.remainingPct.low}–${p.remainingPct.high}% remaining` : null,
    x?.safe ? `safe exit +${x.safe.pct}%` : null,
    x?.primary ? `target +${x.primary.pct}%` : null,
    x?.stop ? `stop ${x.stop.pct}%` : null,
  ].filter(Boolean).join(" · ");

  const text =
    `👁 <b>TRINETRA</b> — ${sig.profileName || "signal"}: ${sig.symbol}\n\n` +
    `<b>${sig.symbol}</b>  ₹${sig.price.toLocaleString("en-IN")}  ${arrow} ${sig.dayChg >= 0 ? "+" : ""}${sig.dayChg}%\n` +
    (sig.lockQuality === "partial"
      ? `Locked on ${sig.total} of ${sig.total + (sig.notEvaluated?.length || 0)} criteria · volume ${sig.volX}× avg\n` +
        `⚠ Not evaluated: ${(sig.notEvaluated || []).join(", ")} — no data, so it could not be judged either way.\n`
      : `All ${sig.total} criteria locked · volume ${sig.volX}× avg\n`) +
    (numbers ? `${numbers}\n` : "") +
    (p?.exhausted ? `\n⚠ The move this setup typically delivers has already happened.\n` : "") +
    (sig.lagDisclosure ? `\n<i>${sig.lagDisclosure}</i>\n` : "") +
    (sig.eventWarning ? `\n⚠ <i>${sig.eventWarning}</i>\n` : "") +
    (x?.suggestion ? `\n${x.suggestion}\n` : "") +
    (p?.basis ? `\n<i>${p.basis}</i>\n` : "") +
    `\n<i>${new Date(sig.at).toLocaleTimeString("en-IN", { hour12: false })} IST</i>\n` +
    `Candidate for review — verify before acting.`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    return (await r.json()).ok;
  } catch {
    return false;
  }
}

/** Shared sender, so every alert type goes out the same way. */
async function send(tg, text) {
  if (!tg?.token || !tg?.chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    return (await r.json()).ok;
  } catch {
    return false;
  }
}

/* An exit alert leads with the reasoning, not the verdict. The user asked for
   the "why" to be unmissable, and it concerns money already at risk — so the
   sentence naming the actual numbers comes before anything else. */
export async function notifyExit(tg, e) {
  const icon = e.severity === "high" ? "🔴" : e.severity === "medium" ? "🟠" : "🟡";
  const ev = e.evidence || {};
  const facts = [
    ev.entryPrice != null ? `entry ₹${Number(ev.entryPrice).toLocaleString("en-IN")}` : null,
    ev.currentPrice != null ? `now ₹${Number(ev.currentPrice).toLocaleString("en-IN")}` : null,
    ev.pctFromEntry != null ? `${ev.pctFromEntry >= 0 ? "+" : ""}${ev.pctFromEntry}% from entry` : null,
    ev.daysHeld != null ? `held ${ev.daysHeld}d` : null,
  ].filter(Boolean).join(" · ");

  const text =
    `${icon} <b>TRINETRA — exit signal</b>\n\n` +
    `<b>${e.symbol}</b> — ${e.headline}\n\n` +
    `${e.reasoning}\n\n` +
    (facts ? `<i>${facts}</i>\n\n` : "") +
    `<b>${e.suggestedAction}</b> — decision support, not an instruction. The call is yours.`;
  return send(tg, text);
}

/** The morning brief, pre-rendered by lib/brief.js. */
export const notifyBrief = (tg, text) => send(tg, text);
