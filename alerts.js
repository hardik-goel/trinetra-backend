/* Telegram delivery — runs server-side so alerts arrive even with
   every browser closed. Uses the user's own bot (token + chat id). */

export async function notify(tg, sig) {
  if (!tg?.token || !tg?.chatId) return false;
  const arrow = sig.dayChg >= 0 ? "▲" : "▼";
  const text =
    `👁 <b>TRINETRA</b> — the eye is open\n\n` +
    `<b>${sig.symbol}</b>  ₹${sig.price.toLocaleString("en-IN")}  ${arrow} ${sig.dayChg >= 0 ? "+" : ""}${sig.dayChg}%\n` +
    `All ${sig.total} criteria locked · volume ${sig.volX}× avg\n` +
    `<i>${new Date(sig.at).toLocaleTimeString("en-IN", { hour12: false })} IST</i>\n\n` +
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
