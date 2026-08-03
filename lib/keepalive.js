/* Self-ping keep-alive — free hosts (Render) sleep after ~15 min idle,
   which delays or drops alerts. We ping ourselves every 10 min, but only
   inside NSE hours, so nights and weekends still sleep for free. */

const EVERY_MS = 10 * 60_000;
const IST_OFFSET_MS = 5.5 * 60 * 60_000; // Asia/Kolkata, no DST
/* Starts before the bell on purpose. The Pravesh trigger's morning window opens
   at 09:00, and a sleeping instance has nothing running to fire it — so the
   keep-alive covers from 08:45 to hold the instance awake through that window
   IF something has already woken it. It still cannot wake a sleeping instance;
   only an external pinger can, which the README states plainly. */
const OPEN_MIN = 8 * 60 + 45;            // 08:45 IST — ahead of the Pravesh slot
const CLOSE_MIN = 16 * 60;               // 16:00 IST — past the afternoon slot

// Server clock is UTC on Render, so derive IST rather than trusting local time.
function inMarketHours(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const day = ist.getUTCDay();                                  // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return min >= OPEN_MIN && min <= CLOSE_MIN;
}

export function startKeepAlive(selfUrl) {
  const url = selfUrl.replace(/\/+$/, "") + "/health";
  console.log(`[keepalive] armed · ${url} · Mon–Fri 09:00–15:45 IST`);

  setInterval(async () => {
    if (!inMarketHours()) return; // market shut — let the instance sleep
    try {
      const r = await fetch(url);
      console.log(`[keepalive] ping ${r.status}`);
    } catch (e) {
      console.log(`[keepalive] ping failed: ${e.message}`);
    }
  }, EVERY_MS);
}
