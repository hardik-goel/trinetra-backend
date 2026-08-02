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
| GET    | /universe   | current watchlist `{ symbols: [] }`      |
| POST   | /universe   | replace the whole list (`[]` = clear all)|
| POST   | /universe/add | add one `{ symbol }`                   |
| POST   | /universe/remove | remove one `{ symbol }`             |
| POST   | /universe/bulk-add | merge many `{ symbols: [] }` → `{ symbols, added, skipped }` |
| POST   | /universe/bulk-remove | remove many `{ symbols: [] }` → `{ symbols, removed }` |

Symbols are normalized identically on every route: trimmed, uppercased, filtered
to `[A-Z0-9&-]`, deduped, capped at 200. Writes land in `universe.runtime.json`,
which takes precedence over the committed `universe.json` on startup. **On
Render's free tier that runtime file is wiped on redeploy** and the committed
list returns — the dashboard re-pushes its list on load, so this is harmless.

## Run it locally (backend + dashboard)
Two processes. The backend serves the API; the dashboard is a separate Next app
in `../trinetra-web` that talks to it over CORS.

```bash
# 1. backend — API + the 24/7 scan loop. PORT is free-form; 8080 keeps 3000 for the UI.
PROVIDER=yahooDelayed PORT=8080 node index.js

# 2. dashboard — point it at the backend so it connects Live without typing a URL
cd ../trinetra-web && NEXT_PUBLIC_BACKEND_URL=http://localhost:8080 npm run dev
```

Open <http://localhost:3000>. Without `NEXT_PUBLIC_BACKEND_URL` the app starts on
the demo feed and you paste the URL by hand in **Data feed → Live delayed feed**.

Checking it came up, without opening a browser:

```bash
curl -s localhost:8080/health        # { ok, provider, lastRefresh, symbols, delayed }
curl -s localhost:8080/snapshot      # what the dashboard renders, fund record included
curl -s localhost:8080/fundamentals  # the scrape cache, status per symbol
```

Two gotchas worth knowing up front:

- **A stale service worker from another `localhost:3000` project will white-screen
  this one** with `Cannot read properties of undefined (reading 'call')` out of
  `webpack.js`. It is serving dead chunks from its own cache, and it survives a
  hard reload. Clear it in DevTools → Application → Service Workers → Unregister,
  or from the console:
  ```js
  (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
  (await caches.keys()).forEach(k => caches.delete(k));
  ```
- **To exercise a UI state the live feed will not sit in** — an unverified
  `seed` record, a `partial` scrape, an empty universe — point the dashboard at a
  throwaway stub instead of editing real data. Anything that answers `/health`,
  `/snapshot`, `/universe` and `/fundamentals` with the shapes above will do; set
  the backend URL to it in the Data feed panel. That is how the seed gate below
  was verified: two stocks with identical passing fundamentals, differing only in
  `status`, so the gate was the single variable.

## Deploy free (Render — ~10 min, no card)
1. Push this folder to a new GitHub repo.
2. render.com → New → Web Service → connect the repo.
3. Render auto-detects `render.yaml`. Click Deploy.
4. Copy the URL (e.g. `https://trinetra-backend.onrender.com`).
5. In the dashboard: **Connect feed** → paste the URL.

Railway/Fly.io work the same way. Free tiers sleep on idle (~30s cold start) —
fine for validation; upgrade to a cheap always-on dyno when you productize.

## Keep-alive (env `SELF_URL`)
A sleeping instance means a missed alert. Set `SELF_URL` to this service's own
deployed URL (e.g. `https://trinetra-backend-tukc.onrender.com`) and the backend
pings its own `/health` every 10 minutes — but only Mon–Fri 09:00–15:45 IST, so
the scan stays warm through the session while nights and weekends still sleep
for free. Leave `SELF_URL` unset and the pinger never starts: the instance
sleeps on idle exactly as before.

## Data quality
Free delayed feeds occasionally return misaligned reference closes; the provider
now derives `prevClose` from the daily series and clamps implausible (>25%) day
moves to avoid false signals. Real live day-change requires the Kite provider.

## Providers (env `PROVIDER`)
- **stooqEod** (default) — free EOD NSE data, most reliable, no key.
- **yahooDelayed** — free ~15-min delayed; sometimes rate-limited (HTTP 403).
- **kite** — Zerodha Kite Connect (₹2,000/mo). LIVE ticks + real order-book
  depth → turns on the 4th criterion (buyers/sellers %) and drops latency to
  1–3s. Follow `providers/kite.js`, then set `PROVIDER=kite`.

Switch provider = change one env var. Nothing else moves. That's the point.

## Your watchlist & fundamentals
- `universe.json` — symbols to scan. **Replace my 22 with your own hunting list.**
  Or edit it live from the dashboard's Universe tab (add, remove, bulk paste,
  CSV upload) — no redeploy needed. See the `/universe` endpoints above.
- `fundamentals.json` — quarterly numbers, now only a **seed**: the backend
  scrapes fundamentals on demand (see below). Missing symbols fail the
  Fundamentals criterion (safe default, never a false positive).

## Fundamentals sources
Startup scrapes anything not already cached, and adding a symbol kicks off a
background scrape. Nothing is scraped on a refresh cycle, because fundamentals
only move quarterly.

A scrape that lands between refresh ticks patches the live snapshot in place and
re-scans immediately, so the served values can never be a minute behind the
status shown next to them.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | /fundamentals | the whole cache, keyed by symbol (status per stock) |
| POST | /fundamentals/refresh | `{ symbol }` → re-scrape one, return the record |
| POST | /fundamentals/refresh-all | re-scrape the universe, paced ~1s apart → `{ refreshed, partial, unavailable }` |

**Sources**, tried in order until one is complete: **screener.in** (ROE, promoter
holding, 3-yr compounded profit growth; D/E derived from Borrowings ÷ net worth;
pledged only when the page calls it out) then **moneycontrol** (ROE, D/E and
promoter/pledged from its shareholding trend blob — this one states `Pledge: 0`
explicitly; 3-yr profit growth is computed as a CAGR from the net-profit
series). If neither source is complete on its own, their partials are merged in
that order and `source` names every site that contributed.

**Status** is `fetched` (all five present and plausible), `partial` (some
missing), `unavailable` (nothing usable) or `seed` (never scraped — the numbers
are whatever `fundamentals.json` says) — and it always reflects what the scrape
actually got. Values outside a plausibility band (ROE −50..100, D/E 0..20,
profit growth −100..300, promoter 0..100, pledged 0..100) are dropped as markup
drift rather than trusted, which downgrades the status. A field the scrape could
not establish falls back to the committed `fundamentals.json`, so hand-entered
numbers still count — but the status never claims more than was scraped.

**A `seed` record cannot lock the Fundamentals criterion.** Hand-entered numbers
are worth showing and worth filling gaps with, but a green tick on a number no
scrape ever confirmed is indistinguishable from a verified one, and this gate is
what decides whether you look at a stock. So fundamentals checks on a `seed`
record evaluate to "unverified" rather than pass: the dashboard shows the values
with a `◌` and labels the gate `UNVERIFIED`, and no signal fires. This is a state
the instrument passes through, not one it sits in — the server scrapes the whole
universe on boot and on every symbol added, so `seed` resolves to `fetched` or
`partial` within a tick or two. `lib/engine.js` owns the rule and the dashboard
ships an identical copy, so what you see and what fires can't drift apart.

**Caching:** results land in `fundamentals.cache.json` (runtime, writable),
which takes precedence over the committed seed. On Render's free tier that file
is wiped on redeploy; the committed `fundamentals.json` survives as the durable
seed, and the dashboard's **Refresh all fundamentals** repopulates the cache.

**When a source changes its HTML**, patch the `SELECTORS` block at the top of
`lib/fundamentals.js` — every selector and label pattern lives there and nowhere
else. Scraping these sites is best-effort and will break from time to time;
that is why a failure degrades to `partial`/`unavailable` instead of guessing.

## Telegram in 3 steps
1. Telegram → @BotFather → `/newbot` → copy the token.
2. Message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy your chat id.
3. Paste both into the dashboard → Alerts → Arm. Alerts now run server-side.

## Order-book depth on free feeds
Buyers/sellers % needs paid exchange depth — no free source has it. The
Order-flow criterion ships **disabled**; the dashboard shows NO DATA rather
than guessing. Kite switches it on.

## Going live with Kite
Real ticks (~1–3s) and real order-book depth. Needs a Kite Connect
subscription (₹2,000/mo) — create the app at
[developers.kite.trade](https://developers.kite.trade).

```
PROVIDER=kite
KITE_API_KEY=your_api_key
KITE_ACCESS_TOKEN=your_daily_access_token
```

**Kite access tokens expire every morning** — refresh `KITE_ACCESS_TOKEN` daily
(via the `request_token` redirect flow, or by hand). If it goes stale the
provider logs `[kite] auth failed — refresh KITE_ACCESS_TOKEN` and returns an
empty cycle; the service keeps running and fires no false signals.

Under Kite, `buyerPct` has real data, so the **Order-flow criterion can safely
be enabled** in the dashboard — it stays user-toggled, and still reads NO DATA
on the free feeds.

Notes: quotes are batched 500 instruments per `getQuote` call; `high20`,
`high52` and `avgVol20` come from `getHistoricalData` once per trading day and
are cached in memory, so the per-cycle path stays cheap. If that history call
fails those three read null (NO DATA) rather than a guess. For true sub-second
streaming the next step is the `KiteTicker` websocket in mode `"full"` — see the
commented `startKiteTicker()` stub at the bottom of `providers/kite.js`; it is
not wired yet.


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
