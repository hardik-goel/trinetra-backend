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

## Criteria profiles (multi-horizon)
One criteria set forced one answer to four different questions. There are now
four profiles, each evaluated independently against every stock, each with its
own criteria and alert preference:

| Profile | Horizon | Keys on |
|---------|---------|---------|
| Intraday | rest of session | opening-range break, VWAP, volume vs the same time yesterday, position in the day's range |
| Swing | ~5 sessions | fundamentals + 20-day breakout + volume shocker (the original set) |
| Positional | ~20 sessions | 50-day breakout, sustained volume, firmer fundamental floor |
| Long term | — | ROE/ROCE/margins, low debt, durable growth, promoter commitment; no day-move criterion |

An existing flat `criteria` array migrates into **Swing**, so tuned thresholds
survive. Signals record which profile fired them, and the track record keeps
them separable — blending an intraday win rate into a long-term one would
describe a strategy nobody runs.

`GET /profiles`, `POST /profiles`, `PATCH /profiles/:id`, `DELETE /profiles/:id`
(refuses the last one). Each snapshot row carries
`profileResults: { <id>: { count, total, locked, criteria } }`.

### Intraday on a delayed feed — what you are actually trading
Intraday is **on** by default and works on the ~15-minute delayed feed, because
if the estimated potential exceeds the move already captured, the remainder is
tradeable. That is a legitimate way to use this data, and it is only legitimate
while the staleness is impossible to overlook. So:

- Every snapshot and signal carries `dataAge: { seconds, lagSeconds, delayed, provider, asOf }`.
- Every intraday signal carries a `lagDisclosure` sentence naming how much of
  the move is already gone, meant to be rendered verbatim.
- **Confidence is capped, not nudged**: 65 on any delayed feed, 55 for intraday
  on one. The top band is unreachable by design. That is the honest consequence
  of trading the tail of a move you cannot see in real time.

Set `PROVIDER=kite` and the lag collapses, the cap lifts automatically, and the
order-flow criteria start returning data. No code change.

## When alerts fire (and when they deliberately do not)
The scan runs 24/7 so the track record stays complete. **Delivery** is a separate
question, and conflating the two is what produced evening alerts about a stock
that stopped moving at 15:30, repeated every minute.

**Window.** Alerts deliver only Mon–Fri **09:15–15:30 IST**, computed from UTC —
the server clock is UTC on Render, and a day boundary taken from local time would
roll at 05:30 IST. Outside the window signals are still recorded and still appear
in Track Record; only delivery is suppressed, logged once per cycle rather than
once per stock.

**Edge, not level.** An alert fires when a stock *becomes* locked, never while it
stays locked. A level-triggered alert repeats forever, because "criteria are
true" remains true after the tape stops. The same rule governs exit signals: once
when a rule first trips, not on every refresh.

**Durable ledger.** `data/alert_ledger.json` survives restarts. A free-tier
instance sleeps and wakes many times a day, and an in-memory ledger meant every
wake re-alerted everything currently qualifying.

**Limits** (in `config.default.json`, editable via `/config`):

| setting | default | meaning |
|---------|---------|---------|
| `cooldownMinutes` | 240 | same symbol stays quiet this long, across all profiles |
| `maxPerSymbolPerDay` | 1 | one entry alert per symbol per trading day |
| `maxPerCycle` | 5 | beyond this, the rest become one digest line |
| `maxPerHour` | 15 | hard ceiling |
| `staleAfterMinutes` | 10 | no alert off a snapshot older than this |
| `preOpenBufferMinutes` / `postCloseGraceMinutes` | 0 | widen the window if wanted |

A stock locking several profiles at once produces **one** alert naming all of
them, not one per profile. A profile can be scanned but silent via
`alerts.telegram: false` — useful while validating Intraday.

**Holidays.** `market_holidays.json` at the repo root, overridable by a runtime
copy in `data/`. It seeds **only fixed-date national holidays** — Republic Day,
Independence Day, Gandhi Jayanti — because those are the only ones that can be
stated without a calendar. Holi, Diwali, Id and the rest move every year and are
deliberately absent: a guessed date either silences a real trading day or lets
alerts fire on a closed one. **Copy the rest from the NSE circular each January.**
With no file at all the gate falls back to weekday-only and says so at startup.

`GET /alerts/status` reports whether the window is open, the next open, counts
sent today and this hour, active cooldowns, the limits, and whether holidays are
configured. Set `ALERT_HOURS_OVERRIDE=true` to bypass the window for testing —
startup warns loudly when it is on.

Every cycle logs one line:
```
[alerts] window=open · age=0m · candidates=10 · sent=5 · suppressed(digested(5))=1
[alerts] window=closed:after close · age=2m · candidates=3 · sent=0 · suppressed(after close)=3
```

## Holdings and exit signals
Marking a holding is one tap — `POST /holdings { symbol }`. Entry price, the
levels, and **the criteria that were locked at that moment** are captured from
the snapshot, because "the reason you bought no longer holds" cannot be detected
later without a record of what that reason was.

Seven rules run per holding on every refresh: stop-loss, target, trailing stop
(default 8% off the peak since entry), structure break, volume dry-up, thesis
break, and time stop. `GET /exit-signals`.

**Every exit signal states its reasoning in full.** An alert that says "SELL" and
nothing else demands the most consequential action in the app while withholding
the evidence for it, so it gets obeyed blindly or ignored — both bad. Instead:

```
[HIGH] POLYCAB — Trend structure broke
You marked this at ₹1,240 on a breakout above the 20-day high of ₹1,232.
Price has now fallen to ₹1,148, below the 20-day low of ₹1,160 — the
structure that justified the entry no longer holds.
Consider exiting — decision support, not an instruction. The call is yours.
```

The word "sell" appears nowhere in the codebase's output. Severity is high for
stop-loss/structure/target, medium for thesis break, low for volume dry-up and
time stop. Alerts are deduped per rule per holding.

## Move potential, confidence, and exit targets
Three numbers per signal: how far this could run, how much is already gone, and
how much the evidence supports. All **estimates derived from that stock's own
history**, never predictions.

- **Potential** scans the stock's past for setups of the same shape and measures
  what followed (max favourable and adverse excursion), reports the 25th/50th/75th
  percentiles, then caps against ATR and the nearest overhead level — naming which
  one bit. Below **8 analogs no numeric range is shown at all**; a "typical move"
  built on three examples is noise wearing a decimal point. When the typical move
  has already happened, `exhausted: true` — the case a delayed feed creates often.
- **Confidence (0–100)** returns its components, never a bare score: evidence
  depth, analog consistency, how far past the thresholds the criteria cleared,
  liquidity, data freshness, event risk, structure headroom. Long term is judged
  on its criteria alone, since it has no move estimate by design.
- **Exits** give safe / primary / stretch / stop, each with reasoning, plus
  risk:reward against the stop. Below 1:1 is flagged explicitly. When resistance
  sits close overhead the three tiers collapse and it says so, rather than
  dressing one level up as three. The `suggestion` reasons from the numbers and
  never instructs — "the evidence favours", never "you should".

Stored on every signal, so `/signals/stats` can eventually answer the only
question that matters: **did confidence and potential correlate with what
happened?** It reports outcomes by confidence band and the hit rate of each exit
level. If high-confidence signals do not outperform low-confidence ones, that
shows up there rather than being quietly buried.

## Events, sizing, concentration, and the morning brief
- `GET /events` — best-effort results/ex-dividend dates scraped alongside
  fundamentals. **When a date cannot be established, nothing is stored** — a
  guessed date is worse than none, because it would let the app claim "no event
  risk" about a stock reporting tomorrow. Signals within 3 sessions of an event
  carry an `eventWarning`.
- `GET /sizing?symbol=&entry=&stop=` sizes from risk, not from capital:
  `(entry − stop) × qty ≈ capital × riskPerTradePct`. With no stop it assumes one
  and says so loudly. `POST /sizing/config { capital, riskPerTradePct }`.
- `GET /concentration` — exposure by sector, largest position, and the
  "six positions, one bet" warning when several holdings share a sector. States
  what it cannot see: holdings without quantity, and symbols with no sector.
- `GET /brief` — one object for "what do I need to know today", and a Telegram
  version at **08:45 IST on weekdays** (configurable via `briefTime`, using the
  same timezone-correct IST logic as the keep-alive). Ordered by what costs money
  soonest: exit signals, then new signals by profile, then IPOs closing, then
  events. **An empty brief is still sent** — silence must always mean breakage,
  never emptiness. `POST /brief/send` to fire one on demand.

## The Playbook — entry, exit, and the evidence for both
Four questions per stock: where to get in, where it is now, where to get out,
what is left. `GET /playbook?symbol=&profile=` for one, `GET /playbook/all` for
the table.

**Convergence is the organising rule.** A level found by one method is that
method's opinion. The same level found by a swing cluster, a Fibonacci
retracement, a moving average and a broker target is a level, because those four
do not share a premise. Candidates are clustered into ATR-sized zones and scored
by how many independent **families** agree — structure, trend, fibonacci, volume,
broker, candlestick. Families rather than candidates: three round numbers near a
price are one opinion three times, and psychological levels get no vote at all,
only reinforcement.

When nothing converges the payload says so. "Four methods, no agreement" is the
finding, not a gap to fill with a confident number.

Levels are always **zones**, never single prices — a level quoted to the paisa on
a stock that swings 2.4% a day is false precision.

### Candlestick evidence, measured on this stock
Patterns are reported only with the context that decides whether they matter: the
prior move (a bullish reversal needs something to reverse), the nearest level
within half an ATR, and volume against the 20-day average. Detections failing the
context test are kept in `detected` for transparency but never reach `valid` or
the evidence list.

Reliability is backtested **per pattern per stock**, never taken from a textbook
table — and always against that stock's own base rate:

```
three_white_soldiers   78.26%  vs baseline 78.78%  →  no better than a random day (n=69)
hammer                  100%   vs baseline 78.78%  →  better than base rate (n=11)
shooting_star          insufficient (n=3)
```

Without the baseline the first line reads "78% reliable". Almost every pattern
clears "price rose 1% within five sessions" on a volatile stock, so the raw rate
measures volatility, not the pattern. Under 8 occurrences there is no rate at all.

### Broker calls and whether the broker was right
`GET /analysts?symbol=` returns calls with targets, ages and each broker's
**measured** hit rate. Every call is logged when seen and resolved later against
what price actually did, inside a six-month window. Below five resolved calls a
broker has a count and no rate.

Calls older than 90 days stop moving levels but still appear, with their age — a
target from last year is history, not a view.

**Scraping brokerage pages does not currently work**, and was not expected to:
Moneycontrol and Trendlyne both return a page whose markup no longer matches any
selector, and these sites actively block automated access. `POST /analysts/scrape`
exists and reports precisely what failed; `analysts.unavailable: true` is the
normal state. The playbook stands without it on technical, candlestick and analog
evidence.

**So enter calls by hand**: `POST /analysts { symbol, broker, call, target,
rationale?, url? }`. Broker names are normalised through an alias map, so
"kotak securities" and "Kotak Institutional Equities" accumulate one record. A
hand-entered call is scored identically — arguably better data, since nothing was
inferred from a page layout that may have changed.

### Evidence includes what argues against
Every entry and exit carries an ordered `evidence[]`, each item with
`stance: "supports" | "opposes" | "neutral"`, a plain-English `detail`, a weight,
and `reliability: { rate, n } | null`. A broker target below the current price and
a bearish pattern at resistance both appear as `opposes`. A one-sided list is
marketing, not analysis.

`reliability: null` means not measurable, which is different from zero — render
"insufficient history", never "0%".

## Watchlists
`universe.json` may be a flat list or `{ "groups": { "Default": [...] } }`. A flat
file migrates into `Default` on first load, and the `/universe` routes keep
operating on that group, so nothing that spoke the old shape breaks.

The engine scans the **union** of every group — a symbol in any list is watched
exactly once. Groups are how the dashboard slices the view, not what the engine
iterates. Each snapshot row carries `groups: ["Default", "Swing"]`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | /watchlists | all groups, counts, total under watch |
| POST | /watchlists | create `{ name }` |
| PATCH | /watchlists/:name | rename `{ name }` |
| DELETE | /watchlists/:name | delete; refuses the last remaining list |
| POST | /watchlists/:name/add | `{ symbols: [] }` |
| POST | /watchlists/:name/remove | `{ symbols: [] }` |
| POST | /watchlists/:name/move | `{ to, symbols: [] }` |

Deleting a list drops symbols held only by it out of the scan set. Removing via
`/universe/remove` removes the symbol from **every** group — otherwise it would
keep being scanned while appearing to have gone.

## Track record — is this worth paying for?
The point of this module is to answer that before a Kite subscription, and to be
capable of answering "no". Nothing in it rounds in the app's favour.

| Method | Path | Purpose |
|--------|------|---------|
| GET | /signals/history?from=&to= | fired signals with their outcomes |
| GET | /signals/stats?days= | win rate, average, median, best/worst per horizon, split by criteria combination |
| GET/POST | /paper-trades | log a bet |
| PATCH/DELETE | /paper-trades/:id | update or close |
| GET | /paper-trades/stats?days=&horizon= | win rate, expectancy, profit factor, and your picking vs taking every signal |
| GET/POST | /ipo-applications | log an application |
| PATCH/DELETE | /ipo-applications/:id | update or remove |
| GET | /ipo-applications/stats?days= | allotment rate, listing gains, and what you passed on |

**Every signal keeps its evidence.** The record stores which criteria locked and
the value that locked each one, so a signal can be re-examined months later
rather than recalled. Forward returns are marked at 1, 3, 7 and 30 days from the
fire price, along with `maxGain` and `maxDrawdown` — a signal that ran +8% before
closing −2% is a different animal from one that drifted down all week, and only
the path tells them apart.

**The comparison that matters** is in `/paper-trades/stats` → `selection`: the
average return of the trades you actually took against the average return of
*every* signal over the same window. A negative `edgePct` means the raw system
beat your selection of it, and the honest response is to take more of its
signals, not fewer.

**Stated assumptions.** Every stats payload carries an `assumptions` array, and
they are not decoration: returns are measured from the delayed-feed price at fire
time rather than a fill you could have got, horizons are wall-clock so a 1-day
return can span a weekend, and **no brokerage, STT, slippage or impact cost is
included anywhere**. Real costs will make every figure worse. Signals still
inside a horizon are reported as `pending`, never as zero, and `n` is stated
everywhere — a 100% win rate over two signals is not a track record.

> **These records do not survive a redeploy on Render's free tier.** They live in
> `data/`, on the same ephemeral disk as the fundamentals cache, so a deploy
> starts your track record — and your open positions — from nothing. A persistent
> disk mounted at `data/` is the real fix, but it is a paid feature. On free tier,
> use backup/restore below before every deploy.

## Backup and restore (the free-tier substitute for a disk)
Set `BACKUP_TOKEN` to any long random string first. Without it both endpoints
return 503 — they read out and can overwrite the entire trading record on a
public URL, so there is deliberately no configuration in which they are open.
`UI_ORIGIN` is no help here: CORS is a browser rule and `curl` ignores it.

```bash
export TOKEN=...   # the BACKUP_TOKEN you set on the service

# before deploying
curl -s -H "X-Backup-Token: $TOKEN" \
     https://your-backend.onrender.com/backup > trinetra-backup.json

# after the deploy comes up
curl -s -X POST https://your-backend.onrender.com/restore \
     -H "X-Backup-Token: $TOKEN" -H 'Content-Type: application/json' \
     --data-binary @<(jq '. + {confirm:true}' trinetra-backup.json)
```

`Authorization: Bearer <token>` works too. Tokens are compared in constant time,
so a wrong one cannot be discovered a character at a time by measuring the
response.

`GET /backup` returns one file containing signal history, paper trades, IPO
applications, holdings, the events cache, **the alert ledger**, **broker calls**,
your watchlist groups, and the tuned config — profiles, thresholds, sizing and
exit rules.

Two of those matter more than they look. Without the **alert ledger** a restore
does not actually restore: every currently-locked stock reads as a fresh edge and
re-fires the storm the market-hours gate exists to prevent. Without **broker
calls** you lose hand-entered research that cannot be regenerated, since
scraping brokerage pages does not work.

**Telegram credentials are deliberately excluded.** The backup travels over HTTP
and lands in a file that will sit around on a laptop; a bot token belongs in
neither, and it comes from the environment anyway. A restore merges rather than
replaces config, so the live credentials survive it.

`POST /restore` requires `confirm: true` — it overwrites records that cannot be
reconstructed, and that should take an explicit act rather than an accidental
request. Before writing anything it saves what was already there to
`data/pre-restore.json`, so restoring the wrong file is itself recoverable. Only
the known filenames are written; a path in the payload is ignored rather than
trusted. Modules re-read from disk afterwards, so the running process serves the
restored records instead of the ones it was holding in memory.

Verified end to end: state created, backed up, `data/` wiped and the process
restarted the way a deploy does, then restored — holdings, paper trades,
watchlists and the frozen entry criteria all came back, and the env-supplied
Telegram credentials were untouched.

### `PRAVESH_DATA_URL` — required for the IPO opportunity-cost number
`/ipo-applications/stats` reports what the engine's own positive calls returned on
IPOs you did **not** log — the figure that can indict the app rather than flatter
it. Computing it means reading the Pravesh snapshot, so without this env var the
payload comes back `skipped: { available: false, reason: "PRAVESH_DATA_URL not
set" }`, and the dashboard prints that reason where the number would be. Point it
at the same file the dashboard reads:

```
PRAVESH_DATA_URL=https://raw.githubusercontent.com/hardik-goel/pravesh-engine/master/data/latest.json
```

Every other IPO statistic — applied, allotment rate, listing gains on allotted —
works without it.

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
- **yahooDelayed** — free ~15-min delayed; sometimes rate-limited (HTTP 403).
  **Use this.** It is what a working deployment currently runs on.
- **stooqEod** — the code default, and currently **broken**: Stooq serves a
  bot-check page instead of CSV, so every symbol returns "no data" and the scan
  set comes back empty. Verified on 2 Aug 2026 — a local run on this default
  logged `[stooqEod] POLYCAB: no data` for all 3 symbols and reported
  `0 symbols via stooqEod`. Set `PROVIDER=yahooDelayed` until the source is
  fixed; the code default is left alone so nobody's deployment changes under them
  without an env edit.
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

### The metric catalog
Every metric is one entry in `fundamentals.config.js`. Nothing else in the
codebase enumerates metric keys — the scraper, the plausibility guard, the
cache, the API and the criteria engine all read that file.

| key | metric | unit | required | where it comes from |
|-----|--------|------|----------|---------------------|
| `roe` | Return on equity | % | yes | screener tile → moneycontrol |
| `roce` | Return on capital employed | % | yes | screener tile |
| `de` | Debt / equity | — | yes | derived: borrowings ÷ net worth → moneycontrol |
| `pe` | Price / earnings | — | yes | screener tile |
| `pb` | Price / book | — | yes | derived: current price ÷ book value |
| `dividendYield` | Dividend yield | % | yes | screener tile |
| `opm` | Operating margin | % | yes | screener P&L row |
| `profitGrowth` | Profit growth (3y) | % | yes | screener growth table → moneycontrol CAGR |
| `salesGrowth3y` | Sales growth (3y) | % | yes | screener growth table |
| `promoter` | Promoter holding | % | yes | screener shareholding → moneycontrol |
| `epsGrowth3y` | EPS growth (3y) | % | no | derived: 3y CAGR of the EPS row |
| `pledged` | Pledged shares | % | no | screener analysis note → moneycontrol |
| `piotroski` | Piotroski F-score | — | no | screener tile, only if present |

**Adding a metric** is one entry in `METRICS`: `key`, `label`, `unit`, a
plausibility `range`, `required`, and how to read it. Most need no new parsing
code — pick an extraction kind: `topRatio` (a tile), `plRow` / `shpRow` (last
column of a statement row), `growth` + `period` (a compounded-growth cell),
`bullet` (a number called out in the analysis notes), or `derive(ctx)` for
anything computed. It becomes scrapeable, cached, API-exposed and selectable as
a criteria check with no other edit. The dashboard needs the same one-line entry
in its `FUND_METRICS` map so the criteria builder can offer it.

**Required vs optional.** `status` is judged on the required metrics only.
Optional ones are still reported in `missing`, but a source legitimately not
publishing something — pledging when there is none, a Piotroski score nobody
added to the page — is not a failed scrape and shouldn't drag every stock to
`partial`.

**Piotroski is parsed, never computed.** screener.in does not ship it; it shows
up only when the page owner has added it as a custom ratio, and it is read when
present. It is deliberately *not* derived: a faithful F-score needs nine signals
across two years, and screener's condensed statements do not expose the
current-ratio and gross-margin inputs cleanly. A six-of-nine approximation
carrying the name "Piotroski" would read as the real thing. A true F-score needs
a dedicated financials pull — that is the work, and it hasn't been done.

**Banks and NBFCs degrade to `partial`, correctly.** They publish Financing
Margin rather than OPM, and a professionally-managed bank has no promoter row at
all. Those metrics stay missing rather than being mapped onto a near-neighbour,
so a bank simply never locks a criterion that cannot be evaluated for it.

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

**Make them survive a redeploy.** Credentials pushed from the Alerts panel live
only in the running instance, so an ephemeral host drops them on every redeploy
and alerts stop without announcing it. Set them as env vars instead and they are
seeded at every startup:

| env var | purpose |
|---------|---------|
| `TELEGRAM_BOT_TOKEN` | bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | your chat id |

Both must be set for the seed to apply; either one alone is ignored. Env wins at
startup and arms alerts; the Alerts panel still overrides for the life of the
process, and the next restart falls back to env. With neither, behaviour is
unchanged — no alerts, no crash. Startup logs which of the three applies:

```
[alerts] telegram: from env | from saved config | awaiting config
```

Declared in `render.yaml` with `sync: false`, meaning the blueprint names the key
but never supplies a value, so a blueprint apply can never blank what you set in
the dashboard. `SELF_URL` and `ORACLE_URL` are declared the same way.

### Secrets are never returned
`GET /config` reports that a channel is configured without revealing it:

```json
"telegram": { "on": true, "configured": true,
              "tokenMasked": "••••abcd", "chatIdMasked": "••••4321",
              "source": "env" }
```

`source` is `env`, `saved` or `none`, so the dashboard can show where the
credentials came from. The full values stay server-side for delivery and are
never sent to a browser.

Because the panel only ever sees the mask, `POST /config` treats a masked or
empty credential as "leave it alone" — only a real new value replaces what is
stored. A request carrying no credentials at all is a criteria sync, so its
`on` flag is ignored too; without that, hitting **Sync criteria** from a panel
that never loaded the credentials would silently disarm alerts armed from the
environment. Sending a real token, or toggling `on` alongside one, works as
before.

### Lock CORS in production
`UI_ORIGIN` restricts every route, reads and writes alike. Set it to your
dashboard's origin — e.g. `https://trinetra-web-zeta.vercel.app`; a
comma-separated list is accepted for a staging origin alongside production.
Left unset it defaults to `*`, and startup says so:

```
[cors] open to any origin — set UI_ORIGIN to your dashboard origin in production
[cors] restricted to https://trinetra-web-zeta.vercel.app
```

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
