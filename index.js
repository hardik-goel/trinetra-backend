/* ================================================================
   TRINETRA · backend
   One service that (1) serves market snapshots to the UI and
   (2) runs the confluence scan server-side so Telegram alerts
   fire 24/7 — no browser tab required.

   Endpoints
     GET  /snapshot      → live array the dashboard reads
     GET  /health        → uptime + provider + last refresh
     GET  /config        → current criteria + alert settings
     POST /config        → update criteria / thresholds / alerts
     GET  /signals       → recent fired signals (audit log)

   Provider is chosen by env PROVIDER=yahooDelayed | kite
   ================================================================ */
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { yahooDelayed } from "./providers/yahooDelayed.js";
import { stooqEod } from "./providers/stooqEod.js";
// import { kite } from "./providers/kite.js";
import { evaluate } from "./lib/engine.js";
import { notify } from "./lib/alerts.js";
import { getForecasts, mergeForecasts } from "./lib/oracle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));

const PROVIDER = process.env.PROVIDER || "stooqEod";
const REFRESH_MS = +(process.env.REFRESH_MS || 60_000);
const SYMBOLS = read("universe.json");
const FUNDAMENTALS = read("fundamentals.json");

const providers = { stooqEod, yahooDelayed /*, kite */ };
const provider = providers[PROVIDER];
if (!provider) throw new Error(`Unknown PROVIDER "${PROVIDER}"`);

// Config is persisted to disk so it survives restarts. On ephemeral
// hosts (Render free) it resets on redeploy — the UI re-pushes it.
const CONFIG_PATH = path.join(__dirname, "config.json");
let config = fs.existsSync(CONFIG_PATH) ? read("config.json") : read("config.default.json");
const saveConfig = () => { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {} };

let snapshot = { at: 0, data: [] };
let signalLog = [];
const firedToday = new Set();
let lastDay = new Date().toDateString();

async function refresh() {
  // reset the per-day dedupe at date rollover
  const today = new Date().toDateString();
  if (today !== lastDay) { firedToday.clear(); lastDay = today; }

  try {
    const quotes = await provider(SYMBOLS);
    const forecasts = await getForecasts(SYMBOLS);
    const enriched = mergeForecasts(quotes, forecasts);
    snapshot = { at: Date.now(), data: enriched.map(q => ({ ...q, fund: FUNDAMENTALS[q.symbol] || null })) };
    console.log(`[trinetra] ${snapshot.data.length} symbols via ${PROVIDER}`);
    scan();
  } catch (e) {
    console.error("[trinetra] refresh failed:", e.message);
  }
}

function scan() {
  for (const s of snapshot.data) {
    const ev = evaluate(s, config.criteria);
    if (ev.locked && !firedToday.has(s.symbol)) {
      firedToday.add(s.symbol);
      const entry = {
        symbol: s.symbol, name: s.name, price: s.price,
        volX: +ev.volX.toFixed(1), dayChg: +ev.dayChg.toFixed(1),
        count: ev.count, total: ev.total, at: Date.now(),
      };
      signalLog = [entry, ...signalLog].slice(0, 100);
      if (config.alerts?.telegram?.on) {
        notify(config.alerts.telegram, entry).catch(e => console.error("[alert]", e.message));
      }
    }
  }
}

const app = express();
app.use(cors({ origin: process.env.UI_ORIGIN || "*" }));
app.use(express.json());

app.get("/health", (_, res) =>
  res.json({ ok: true, provider: PROVIDER, lastRefresh: snapshot.at, symbols: snapshot.data.length, delayed: PROVIDER === "yahooDelayed" }));

app.get("/snapshot", (_, res) =>
  res.json({ asOf: snapshot.at, provider: PROVIDER, delayed: PROVIDER === "yahooDelayed", data: snapshot.data }));

app.get("/signals", (_, res) => res.json(signalLog));

app.get("/config", (_, res) => res.json(config));
app.post("/config", (req, res) => {
  const { criteria, alerts } = req.body || {};
  if (Array.isArray(criteria)) config.criteria = criteria;
  if (alerts) config.alerts = alerts;
  saveConfig();
  scan(); // re-evaluate immediately against the new rules
  res.json({ ok: true, config });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[trinetra] listening :${PORT} · provider=${PROVIDER}`);
  await refresh();
  setInterval(refresh, REFRESH_MS);
});
