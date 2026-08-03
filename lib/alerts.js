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
