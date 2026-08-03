import { formatSignal } from "./alertFormat.js";

/* Telegram delivery — runs server-side so alerts arrive even with
   every browser closed. Uses the user's own bot (token + chat id). */

export async function notify(tg, sig, stock) {
  if (!tg?.token || !tg?.chatId) return false;
  return send(tg, formatSignal(sig, stock || {}));
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
    `${icon} <b>TRINETRA</b> · CLOSE POSITION\n\n` +
    `<b>${e.symbol}</b> — ${e.headline}\n\n` +
    `${e.reasoning}\n\n` +
    (facts ? `<i>${facts}</i>\n\n` : "") +
    `<b>Consider ${e.suggestedAction.toLowerCase().replace("consider ", "")}</b> — this is your existing position, not a new bearish trade idea.\n` +
    `Decision support, not an instruction. The call is yours.`;
  return send(tg, text);
}

/** The morning brief, pre-rendered by lib/brief.js. */
export const notifyBrief = (tg, text) => send(tg, text);

/* Trading around a core holding. The subtitle is mandatory and rendered under
   the header on its own line: it is the only thing separating "sell a portion"
   from "close the position", and confusing those costs the user a position he
   meant to keep. */
export async function notifyCycle(tg, sig) {
  const isSell = sig.kind === "sell";
  const icon = isSell ? "💰" : "👁";
  const L = [];
  L.push(`${icon} <b>TRINETRA</b> · ${isSell ? "SELL" : "BUY"} · ${sig.symbol}`);
  L.push(`   <i>${sig.subtitle}</i>`);
  L.push("");

  for (const c of sig.criteria || []) {
    const mark = c.pass ? "✓" : c.skipped ? "—" : "·";
    const name = c.name.padEnd(14);
    L.push(`${mark} ${name}${c.detail || (c.skipped ? "no data" : "not met")}`);
  }

  L.push("");
  if (isSell && sig.holding) {
    const h = sig.holding;
    L.push(`<b>Your holding</b>  entry ₹${h.entryPrice} · now ₹${h.currentPrice} · +${h.gainPct}%`);
    if (h.heldMonths != null) {
      L.push(`<b>Held</b>          ${h.heldMonths} month${h.heldMonths === 1 ? "" : "s"}${h.stcg ? " — selling realises STCG" : ""}`);
      if (h.holdingPeriod?.caveat) L.push(`   <i>${h.holdingPeriod.caveat}</i>`);
    }
  }
  if (!isSell && sig.belowSalePct != null && sig.sellPrice) {
    L.push(`<b>${Math.abs(sig.belowSalePct).toFixed(1)}% below your sale at ₹${sig.sellPrice}</b>`);
  }
  L.push(`<b>Suggested</b>     ${sig.suggestion}`);
  if (sig.reentryRisk) L.push(`<i>${sig.reentryRisk}</i>`);

  L.push("");
  const t = new Date(sig.at).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }).slice(0, 5);
  L.push(`<i>${t} IST${sig.dataAge?.delayed ? ` · prices ~${Math.round((sig.dataAge.lagSeconds || 900) / 60)} min delayed` : ""}</i>`);
  return send(tg, L.join("\n"));
}
