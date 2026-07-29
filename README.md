# Trinetra · backend

Serves live market snapshots to the Trinetra dashboard **and** runs the
confluence scan server-side, so Telegram alerts fire 24/7 with no browser open.

## What it does
- Pulls free delayed NSE data for your watchlist every minute
- Evaluates your criteria (same engine as the UI)
- Fires a Telegram alert the moment a stock locks every enabled criterion
- Exposes a clean JSON API the dashboard reads

## Endpoints
| Method | Path        | Purpose                                  |
|--------|-------------|------------------------------------------|
| GET    | /snapshot   | current market array for the dashboard   |
| GET    | /health     | uptime, provider, last refresh           |
| GET    | /config     | current criteria + alert settings        |
| POST   | /config     | push criteria/alerts from the dashboard  |
| GET    | /signals    | recent fired signals (audit log)         |

## Deploy free (Render — ~10 min, no card)
1. Push this folder to a new GitHub repo.
2. render.com → New → Web Service → connect the repo.
3. Render auto-detects `render.yaml`. Click Deploy.
4. Copy the URL (e.g. `https://trinetra-backend.onrender.com`).
5. In the dashboard: **Connect feed** → paste the URL.

Railway/Fly.io work the same way. Free tiers sleep on idle (~30s cold start) —
fine for validation; upgrade to a cheap always-on dyno when you productize.

## Providers (env `PROVIDER`)
- **stooqEod** (default) — free EOD NSE data, most reliable, no key.
- **yahooDelayed** — free ~15-min delayed; sometimes rate-limited (HTTP 403).
- **kite** — Zerodha Kite Connect (₹2,000/mo). LIVE ticks + real order-book
  depth → turns on the 4th criterion (buyers/sellers %) and drops latency to
  1–3s. Follow `providers/kite.js`, then set `PROVIDER=kite`.

Switch provider = change one env var. Nothing else moves. That's the point.

## Your watchlist & fundamentals
- `universe.json` — symbols to scan. **Replace my 22 with your own hunting list.**
- `fundamentals.json` — quarterly numbers from screener.in. Missing symbols
  fail the Fundamentals criterion (safe default, never a false positive).

## Telegram in 3 steps
1. Telegram → @BotFather → `/newbot` → copy the token.
2. Message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy your chat id.
3. Paste both into the dashboard → Alerts → Arm. Alerts now run server-side.

## Order-book depth on free feeds
Buyers/sellers % needs paid exchange depth — no free source has it. The
Order-flow criterion ships **disabled**; the dashboard shows NO DATA rather
than guessing. Kite switches it on.


## AI Forecast criterion (Kronos Oracle)
An optional 5th, forward-looking criterion powered by Kronos — an open-source
(MIT) foundation model for candlestick forecasting. Runs as a separate
microservice (`trinetra-oracle`, included in the package):
1. Deploy the oracle (Hugging Face Spaces Docker free tier fits the torch
   image; `MODE=naive` fits anywhere).
2. Set `ORACLE_URL=https://your-oracle...` on this backend.
3. Enable the "AI Forecast (Kronos)" criterion in the dashboard.
Forecasts refresh once per day (EOD candles) and are cached. If the oracle is
down, the criterion reads NO DATA — it never fakes a forecast.

## Disclaimer
Decision support, not investment advice. Verify data before acting.
Markets carry risk of loss.
