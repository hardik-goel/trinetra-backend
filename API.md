# Trinetra backend — API contract

For anyone building the dashboard against this backend. Shapes here are what the
server actually returns; where a shape changed recently it says so, because the
dashboard predates several of these.

Base URL is whatever `NEXT_PUBLIC_BACKEND_URL` points at. Every route is subject
to `UI_ORIGIN` CORS (defaults to `*`; production should name the dashboard
origin).

---

## What changed most recently (read this first)
If you are wiring the dashboard, these are the surfaces that are new or reshaped:

1. **Criteria are now profiles, not one set.** `config.criteria` is gone as the
   thing the engine reads; `config.profiles` replaces it. Each snapshot row
   carries `profileResults`. The old array was migrated into the `swing` profile.
2. **`dataAge` on `/snapshot` and on every signal**, plus `lagDisclosure` on
   intraday signals — render it verbatim, it is the honesty contract for running
   intraday on a delayed feed.
3. **Every signal carries `potential`, `confidence` and `exits`** (A8). These are
   the three numbers the user decides on.
4. **Holdings + exit signals** — one-tap `POST /holdings { symbol }`, and
   `GET /exit-signals` returning full `rationale`.
5. **`/brief`** assembles the whole morning view server-side, so the dashboard
   can render it without composing it.
6. `/snapshot` no longer ships candle arrays (server-side analysis only).
7. **`originalFour` on `GET /profiles`**, plus `POST /criteria/restore-original-four`
   — the four criteria the app was commissioned against, in the user's own words,
   with each one's live state. Render from this, never from a hardcoded list.
8. **Named experts** in the analyst ledger (`kind: "expert"`), and a hard 10-point
   cap on their combined confidence contribution.
9. **`direction` is on every playbook, signal, cycle signal and history record**,
   and the price labels travel with the payload. Do not infer them.

---

## Market data

### `GET /health`
```json
{ "ok": true, "provider": "yahooDelayed", "lastRefresh": 1785680293121,
  "symbols": 3, "delayed": true }
```

### `GET /snapshot`
```json
{ "asOf": 1785680293121, "provider": "yahooDelayed", "delayed": true,
  "data": [ { "symbol": "POLYCAB", "name": "Polycab India Limited",
              "price": 9106.5, "prevClose": 8895.2, "high20": 9200,
              "high52": 9950, "volToday": 812000, "avgVol20": 240000,
              "bidQty": 0, "askQty": 0,
              "groups": ["Default", "Swing"],
              "fund": { "roe": 22.7, "roce": 32.9, "de": 0.008, "pe": 48.9,
                        "pb": 11.57, "dividendYield": 0.52, "opm": 14,
                        "profitGrowth": 26, "salesGrowth3y": 27,
                        "promoter": 61.46, "epsGrowth3y": 26.8, "pledged": 0,
                        "piotroski": null,
                        "status": "fetched", "source": "screener.in+moneycontrol",
                        "fetchedAt": 1785680293121 },
              "fcst": { "ret": 2.4, "horizon": 3, "engine": "kronos-mini",
                        "path": [9200, 9250, 9310] } } ] }
```

- **`groups`** is new. It is what a watchlist filter should read — no second
  fetch needed. Re-tagged immediately on any watchlist mutation.
- **`fund.status`** is `fetched` | `partial` | `unavailable` | `seed` | `demo`.
- **`fcst`** is absent when the Oracle has no forecast for that symbol. Absent
  means "no data", not "zero".

---

## Fundamentals

`GET /fundamentals` → the whole cache keyed by symbol.
`POST /fundamentals/refresh` `{symbol}` → re-scrape one, returns the record.
`POST /fundamentals/refresh-all` → `{refreshed, partial, unavailable}`.

**The metric catalog is `fundamentals.config.js`** and the dashboard mirrors it.
Keys must match exactly — a key the UI invents reads `undefined` and silently
evaluates as "no data". Current keys:

`roe` `roce` `de` `pe` `pb` `dividendYield` `opm` `profitGrowth`
`salesGrowth3y` `promoter` `epsGrowth3y` `pledged` `piotroski`

`pledged`, `epsGrowth3y` and `piotroski` are optional — a source legitimately may
not publish them, so their absence is not a failed scrape and does not make the
record `partial`. `piotroski` is parsed only if a page exposes it as a custom
ratio; it is never computed.

### The two rules the mirrored engine must obey
The dashboard ships its own copy of `lib/engine.js`. If the copies disagree, what
the user sees and what fires the alert diverge. Two rules carry that:

1. **Metric keys match the catalog exactly.** Prefer unioning the keys the
   backend actually sends over hardcoding a list.
2. **`fund.status === "seed"` must evaluate as *unverified*, not pass.** Seed
   values are hand-entered numbers no scrape ever confirmed. They are shown, but
   they cannot tick a box or lock a gate, because a green tick on an unverified
   number is indistinguishable from a verified one — and this gate decides
   whether a stock gets looked at. Render them with a distinct marker and label
   the gate `UNVERIFIED`, not `OPEN` (it did not fail a test; it was not tested).

---

## Watchlists

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/watchlists` | | `{groups, counts, total}` |
| POST | `/watchlists` | `{name}` | 409 if it exists |
| PATCH | `/watchlists/:name` | `{name}` | rename; keeps tab order |
| DELETE | `/watchlists/:name` | | 400 on the last remaining list |
| POST | `/watchlists/:name/add` | `{symbols: []}` | |
| POST | `/watchlists/:name/remove` | `{symbols: []}` | |
| POST | `/watchlists/:name/move` | `{to, symbols: []}` | |

The engine scans the **union** of all groups — a symbol in any list is watched
once. Groups slice the view; they never change what is scanned beyond their
union.

`/universe` still works and operates on the `Default` group. Its response grew a
field: `{symbols, groups: {name: count}}`. `symbols` is unchanged.
`/universe/remove` removes from **every** group.

---

## Alerts config

### `GET /config` — secrets are masked
```json
{ "criteria": [...],
  "alerts": { "telegram": { "on": true, "configured": true,
                            "tokenMasked": "••••abcd", "chatIdMasked": "••••4321",
                            "source": "env" } } }
```

`source` is `env` | `saved` | `none`. **The raw token and chat id are never
returned** — they can come from the server's environment and are secrets the
browser was never given.

### `POST /config`
Send `{criteria}` and/or `{alerts: {telegram: {on, token, chatId}}}`.

- A **masked or empty** token/chatId means "leave it alone". Only a real value
  replaces what is stored.
- A payload carrying **no credentials at all** is treated as a criteria sync, so
  its `on` is ignored — otherwise syncing criteria from a panel that never loaded
  the credentials would silently disarm alerts armed from the environment.

So the Alerts panel should render armed state from `configured` / `source` /
`tokenMasked` rather than expecting to read back what it sent. Sending a real
token still works exactly as before.

---

## Track record

| Method | Path | Returns |
|--------|------|---------|
| GET | `/signals` | live tail, last 100, each with an `id` |
| GET | `/signals/history?from=&to=` | `{signals: [...]}` with outcomes |
| GET | `/signals/stats?days=` | aggregates, per horizon and per criteria combination |
| GET | `/paper-trades` | `{trades: [...]}` open trades carry `mtm` |
| POST | `/paper-trades` | `{symbol, entryPrice, qty, signalId?, stopLoss?, target?, notes?}` |
| PATCH | `/paper-trades/:id` | update, or close with `{status:"closed", exitPrice, exitReason}` |
| DELETE | `/paper-trades/:id` | |
| GET | `/paper-trades/stats?days=&horizon=` | win rate, expectancy, profit factor, selection edge |
| GET/POST | `/ipo-applications` | |
| PATCH/DELETE | `/ipo-applications/:id` | |
| GET | `/ipo-applications/stats?days=` | allotment rate, listing gains, what you skipped |

A signal-history record keeps the evidence at fire time:

```json
{ "id": "sig_...", "symbol": "POLYCAB", "firedAt": 1785680293121, "price": 9106.5,
  "combo": "B+F+V", "count": 3, "total": 3, "groups": ["Default"],
  "criteria": [ { "key": "F", "name": "Fundamentals", "pass": true,
                  "checks": [ { "metric": "roe", "op": "gte", "threshold": 15,
                                "value": 22.7, "ok": true } ] } ],
  "outcome": { "ret1d": 1.2, "ret3d": null, "ret7d": null, "ret30d": null,
               "maxGain": 3.4, "maxDrawdown": -0.8,
               "lastPrice": 9210, "lastAt": 1785690000000 } }
```

`/signals` entries carry the same `id`, which is how "log a paper trade from this
signal" links the two via `signalId`.

**The number that gives the module its point** is `/paper-trades/stats` →
`selection`: the average return of the trades you actually took against the
average return of *every* signal over the same window. A negative `edgePct` means
the raw system beat your selection of it.

### The honesty requirement — this is not optional decoration
Every stats payload carries an `assumptions` array. **Render it.** The module
exists to decide whether the app is worth paying for, so it must be capable of
saying "no":

- Returns use the delayed-feed price at fire time, not a fill anyone could have got.
- Horizons are wall-clock, so a 1-day return can span a weekend.
- **No brokerage, STT, slippage or impact cost is included anywhere.** Real costs
  make every figure worse.
- Signals still inside a horizon are `pending`, never zero.
- `n` accompanies every rate. A 100% win rate over 2 signals is not a track
  record, and the UI must not let it look like one.
- `profitFactor` is `null` with a `profitFactorNote` when there are no losses —
  "nothing has lost yet" is not the same claim as "no data".

A panel that shows a win rate without its `n` and its costs caveat is worse than
showing nothing.

> These records live in `data/` on the same ephemeral disk as the caches. On
> Render's free tier a redeploy wipes them, which defeats measuring anything over
> months. A persistent disk mounted at `data/` is the fix.

---

## Profiles, exits, sizing, brief (added with this build)

### `GET /profiles` · `POST` · `PATCH /profiles/:id` · `DELETE /profiles/:id`
```json
{ "profiles": { "intraday": { "name": "Intraday", "horizon": "intraday",
                              "enabled": true, "requiresLiveData": false,
                              "alerts": { "telegram": true }, "criteria": [...] },
                "swing": {...}, "positional": {...}, "longterm": {...} } }
```
Horizons: `intraday` | `swing` | `positional` | `longterm`. DELETE refuses the
last remaining profile. The dashboard's criteria editor should now edit **one
profile at a time**, not a single global list.

Each `/snapshot` row gains:
```json
"profileResults": { "swing": { "count": 2, "total": 3, "locked": false, "criteria": [...] } }
```
Use this for a per-horizon column or tab. `criteria` matches the existing
`evaluate()` shape, so existing rendering works per profile.

### Signals — new fields
```json
{ "id": "sig_...", "symbol": "POLYCAB", "profileId": "swing", "profileName": "Swing",
  "horizon": "swing", "count": 3, "total": 3,
  "dataAge": { "seconds": 41, "lagSeconds": 900, "delayed": true, "provider": "yahooDelayed" },
  "lagDisclosure": "Prices are ~15 minutes delayed. This stock has already moved +3.1% since the trigger level; the estimate below is what may remain, not the full move.",
  "eventWarning": "Results due in 2 days — this signal carries binary event risk.",
  "potential": {
    "horizon": "swing", "sessions": 5, "triggerPrice": 8827, "movedAlreadyPct": 3.09,
    "estRangePct": { "low": 1.2, "median": 2.4, "high": 4.8 },
    "remainingPct": { "low": 0, "median": 0, "high": 1.7 },
    "exhausted": true, "converged": false,
    "cappedBy": "resistance:swing-high@9169.5",
    "resistance": { "level": "swing-high", "price": 9169.5 },
    "analogs": { "n": 10, "medianMFE": 2.36, "medianMAE": -2.67, "winRate": 50 },
    "basis": "10 comparable setups in this stock; median best case +2.36%, typical drawdown -2.67% over 5 sessions. Matched on breakout and volume shape, not on the full criteria set."
  },
  "confidence": { "score": 40, "band": "low",
                  "components": [ { "name": "Evidence depth", "contribution": 6, "note": "10 historical analogs" } ],
                  "caps": ["delayed feed: capped at 65"],
                  "summary": "Low (40). …" },
  "exits": { "safe": { "pct": 1.2, "price": 9209, "rationale": "…" },
             "primary": {...}, "stretch": {...}, "stop": {...},
             "riskReward": { "toSafe": 0.4, "toPrimary": 0.8, "toStretch": 1.6 },
             "riskRewardWarning": "Risk-reward to the primary target is below 1:1.",
             "suggestion": "…reasoning, never an instruction…" } }
```

**Rendering rules that are not optional:**
- `potential` is **null for `longterm`** — a % target over years is meaningless
  and is deliberately not produced. Do not render an empty range; say the
  horizon does not carry one.
- `insufficientHistory: true` means **no numeric range exists** (fewer than 8
  analogs). Show `bounds` and `basis`, never a fabricated range.
- `exhausted: true` — lead with it. The typical move already happened.
- `converged: true` — safe/primary/stretch are the *same* level because
  resistance is close overhead. Render one level, not three identical ones.
- Always show `analogs.n` next to any range, and `confidence.caps` next to any
  score, or the user cannot tell why nothing ever scores high.

### `GET /holdings` · `POST /holdings` · `PATCH /holdings/:id` · `DELETE`
`POST { symbol }` is enough — **one tap**. The user does not paper-trade and will
not fill a form; entry price, levels and the locked criteria are captured from
the snapshot. Optional: `entryPrice, qty, stopLoss, target, profileId, note`.

### `GET /exit-signals`
```json
{ "signals": [ { "id": "hld_x:structure_break", "holdingId": "hld_x", "symbol": "POLYCAB",
    "rule": "structure_break", "headline": "Trend structure broke",
    "reasoning": "You marked this at ₹1,240 on a breakout above the 20-day high of ₹1,232. Price has now fallen to ₹1,148, below the 20-day low of ₹1,160 — the structure that justified the entry no longer holds.",
    "evidence": { "entryPrice": 1240, "currentPrice": 1148, "triggerLevel": 1160,
                  "pctFromEntry": -7.4, "daysHeld": 9 },
    "severity": "high", "suggestedAction": "Consider exiting",
    "note": "Decision support, not an instruction — the call is yours." } ],
  "rules": {...}, "dataAge": {...} }
```
Sorted highest severity first. **Render `reasoning` prominently — it is the whole
point of the feature.** Never render a bare "SELL"; the API never says it.

### Sizing & concentration
- `GET /sizing/config` · `POST /sizing/config { capital, riskPerTradePct, defaultStopPct, sectorLimitPct }`
- `GET /sizing?symbol=&entry=&stop=` → `{ qty, rupeeRisk, positionValue, positionPctOfCapital, stopAssumed, notes[] }`.
  `stopAssumed: true` means the stop was invented — surface `notes`.
  Returns `{ error }` when capital is unset.
- `GET /concentration` → `{ sectors[], largestPosition, warnings[], caveats[] }`.
  Render `caveats` — they state what the numbers cannot see.

### `GET /brief` · `POST /brief/send`
```json
{ "generatedAt": 0,
  "newSignals": { "total": 3, "byProfile": { "swing": [ …signals… ] } },
  "holdings": [ { "symbol", "entryPrice", "unrealisedPct", "daysHeld", "exitSignals": [...] } ],
  "exitSignals": [...], "ipos": [...], "events": [ { "symbol", "event": { "type", "date", "daysAway" } } ],
  "concentration": {...},
  "dataHealth": { "provider", "delayed", "lagSeconds", "ageSeconds", "lastRefresh", "symbols", "expected", "failures" } }
```
Order is deliberate: **exit signals first** (money already at risk), then new
signals by profile, then IPOs closing, then events. Keep that order in the UI.
`dataHealth` must be visible so a stale brief is never read as a live one.

A Telegram brief fires at 08:45 IST on weekdays (`config.briefTime`). An empty
brief is still sent — silence means breakage, never emptiness.

### `GET /events`
`{ events: { SYMBOL: { checkedAt, events: [ { type, date } ] } } }`. Absent means
"could not establish", never "no event" — do not render absence as safety.

---

## Decision data for lists and drawers (added after the dashboard's first bind)

### `/snapshot` rows — `decisions`
Compact and sortable, one entry per enabled profile. Deliberately not the full
payload: components, rationale and analog detail are heavy and only wanted when
a row is opened.

```json
"decisions": { "swing": { "profileId": "swing",
                          "confidence": { "score": 65, "band": "moderate", "capped": true },
                          "remainingMedianPct": 0.76, "rrToPrimary": 0.2,
                          "exhausted": false, "insufficientHistory": false,
                          "noEstimate": false, "analogsN": 10 } }
```

Sort the watchlist on `confidence.score`, `remainingMedianPct` or `rrToPrimary`
directly. Three null cases that must sort and render differently — they are not
interchangeable:

- `noEstimate: true` — long term, which carries no move estimate by design.
- `insufficientHistory: true` — fewer than 8 analogs, so no range exists.
- `remainingMedianPct: 0` with `exhausted: true` — a range exists and it is spent.

`null` means "no view", never "no upside".

### `GET /decision?symbol=&profile=`
The full surface for the detail drawer: `potential`, `confidence` (with
components and caps), `exits` (with rationale per rung and `riskReward`),
`criteria`, `nextEvent`, `dataAge`, and `lagDisclosure` on intraday. Works
whether or not the profile is currently locked — asking "what would this be
worth" deserves an answer before it fires.

### `GET /exit-signals` — fired and armed are separate arrays
```json
{ "signals": [ …rules that FIRED… ], "armed": [ …rules that have not… ],
  "rules": {...}, "dataAge": {...} }
```
`signals` is fired-only. Armed entries carry `distanceToTriggerPct` and
`action: "watch"`, so "trailing stop 2% away" cannot be rendered with the same
affordances as a rule that actually broke.

### `nextEvent` is already on every `/snapshot` row
`{ type, date, daysAway, sessionsAway, source, fetchedAt, stale }` — no
companion `/events` call needed for a row chip.

### `GET /backup` · `POST /restore`
Free-tier substitute for a persistent disk. `/backup` returns one JSON with
signal history, paper trades, IPO applications, holdings, the events cache,
watchlist groups and the tuned config (profiles, thresholds, sizing, exit rules).

**Telegram credentials are excluded on purpose** — the file travels over HTTP and
gets kept on disk. A restore merges config rather than replacing it, so live
credentials survive.

`POST /restore` needs `confirm: true`, saves the current state to
`data/pre-restore.json` first, ignores any filename it does not recognise, and
reloads every module from disk so the process stops serving stale records.

If the dashboard surfaces this, it is a settings-panel action, not a routine
one: "Download backup" before a deploy, "Restore from file" after.

**Auth:** `/backup` and `/restore` require `X-Backup-Token` (or
`Authorization: Bearer …`) matching the service's `BACKUP_TOKEN`. With that env
var unset both return **503** rather than serving — they expose and can destroy
the whole trading record, and CORS does not protect a non-browser caller.

### `GET /alerts/status`
```json
{ "windowOpen": false, "reason": "after close", "tradingDay": "2026-08-03",
  "nextOpen": "2026-08-04T09:15+05:30", "sentToday": 2, "sentLastHour": 0,
  "activeCooldowns": [ { "symbol": "POLYCAB", "minutesRemaining": 180 } ],
  "limits": { "cooldownMinutes": 240, "maxPerCycle": 5, "…": 0 },
  "holidays": { "configured": true, "count": 3 },
  "override": false, "telegramArmed": true,
  "lastCycle": { "candidates": 3, "sent": 0, "suppressed": { "after close": 3 } } }
```
Alerts deliver only Mon–Fri 09:15–15:30 IST and are edge-triggered. Signals are
still **recorded** outside the window — suppression is about delivery, so Track
Record stays complete. Worth surfacing `windowOpen` + `nextOpen` in the UI, or a
quiet evening looks like a broken backend.

---

## Playbook

`GET /playbook?symbol=&profile=` · `GET /playbook/all?profile=` ·
`GET /analysts?symbol=` · `POST /analysts` · `POST /analysts/scrape`

Shapes are as in `docs/PLAYBOOK_CONTRACT.md`, with these differences from that
proposal, all additive:

- `entry.families` / `exits.*.families` — which independent method families back
  the zone (`structure`, `trend`, `fibonacci`, `volume`, `broker`, `candlestick`).
  `convergence` is that list's length.
- `exits.safe|primary|stretch` each carry `zone`, `mid`, `pct`, `anchor`,
  `convergence`, `families`, `evidence` — there is no flat `ladder` array.
- **`/playbook/all` rows nest identically to `/playbook`**: `entry.*` and
  `exits.{primary,stop,riskReward,riskRewardWarning,confidence}`. The compact row
  briefly hoisted those to the top level, so a caller reading the nested shape got
  an em dash from a row that had the numbers. One path works for both now.
  `riskRewardWarning` is in the compact row as well — sub-1:1 is exactly the row a
  fast scan of a table should not skip.
- `candles.detected` includes context-INVALID patterns for transparency;
  `candles.valid` is the list that may be shown as evidence. Do not render
  `detected` as findings.
- `analysts.unavailable: true` is the normal state today — scraping is blocked.
  Offer manual entry rather than an empty panel.

**Percentages are measured from `basisPrice`, not from spot.** For an untriggered
setup that is the entry zone — the price you would actually pay — because measuring
from spot describes buying now, which the entry rule forbids. The payload states
which it used:

```json
"basisPrice": 1907.8, "basis": "entry zone — the setup has not triggered yet",
"potential": { "toPrimaryPct": 3.52, "fromSpotToPrimaryPct": 18.26, … }
```

`fromSpotToPrimaryPct` is there if you want to show the distance from the current
price, but it is not the trade's potential and should never drive risk-reward.

**Rendering rules that are not cosmetic:**
- Levels are zones. Never render a single price where the payload gives a range.
- `convergence: 0` is a finding — "no level here, methods disagree" — not an
  empty state.
- Render `stance: "opposes"` items with equal prominence to supporting ones.
- `reliability: null` → "insufficient history", never "0%".
- `entry.chasing: true` → surface `entry.warning` prominently; it is the single
  most common way a good signal becomes a bad trade.
- `riskRewardWarning` is set when R:R to the primary target is below 1:1.

### `lockQuality` is on snapshot rows as well as signals
`profileResults[<id>]` now carries `lockQuality`, `lockedOn[]`, `notEvaluated[]`
and `warnings[]` alongside `count`/`total`/`locked`.

It was previously only on fired signals, which meant a stock that is
locked-but-partial *right now* — or whose fundamentals cannot be evaluated —
showed nothing until it fired, and a watchlist could only learn the state by
polling `/signals` for stocks that happened to fire today. The live state belongs
on the live payload.

`lockQuality: "partial"` means at least one criterion was excluded because it had
no data. It is a materially different event from `"full"` and must not render
identically — the excluded criterion is named in `notEvaluated[]`.

---

## Sell / buy-back cycle (trading around a core holding)

Naming follows `trinetra-web/docs/CYCLE_CONTRACT.md`. **Note two fields where that
doc and the summary message differed — the doc wins:**
`kind` is **`"sell"` | `"buyBack"`** (not `sell_holding`/`buy_back`), and the field
is **`reentryRisk`** (one capital, not `reEntryRisk`).

### `GET /profiles` — `originalFour`

The founding four criteria, read out of the engine so the panel can never drift
from what actually runs:

```json
"originalFour": [
  { "id": "fund", "originalIndex": 1, "originalPhrase": "Fundamentally strong",
    "name": "Fundamentals", "status": "active", "present": true,
    "countsTowardLock": true,
    "checks": [ { "metric": "roe", "op": "gte", "value": 15 }, … ] },
  { "id": "flow", "originalIndex": 4,
    "originalPhrase": "Buyers and sellers count and percentage",
    "name": "Order flow", "status": "awaiting live data (Kite)",
    "present": true, "dormant": true, "countsTowardLock": false,
    "dormantReason": "order-book depth is paid exchange data — unavailable on the free delayed feed",
    "requiresProvider": "kite" }
]
```

`status` is one of `"active"`, `"awaiting live data (Kite)"`, `"disabled by you"`,
`"removed"`. **Render `originalPhrase` as the label** — those are the user's words
for what he asked for, and the engine's `name` is a shorter internal one.

The fourth is **present and disabled**, not missing. Show it greyed with its
`dormantReason`, not hidden — the point is that it is visibly waiting rather than
forgotten. `countsTowardLock: false` means it is out of the lock denominator, which
is why the header reads 3/3 rather than 3/4 with an unreachable fourth. A disabled
criterion does not affect `matchesCanonical`, so the drift banner stays quiet.

```
POST /criteria/restore-original-four  { profile? }   → { ok, criteria, originalFour, matchesCanonical }
```
Same effect as `restore-defaults`, named the way the user names it. Both now return
`originalFour` so the panel can re-render from one response.

---

### Named experts — `POST /analysts/experts`, `GET /analysts?symbol=`

Calls from named experts (**Sandeep Jain**, **Anil Singhvi**) sit in the same ledger
as brokerage targets, distinguished by `kind`:

```json
{ "broker": "Sandeep Jain", "kind": "expert", "call": "Book profit",
  "target": 9500, "stance": "bearish", "rationale": "…", "url": "…",
  "seenAt": "2026-08-03T…", "staleAfterDays": 45,
  "accuracy": { "n": 3, "insufficient": true } }
```

Three things to render honestly:

- **`staleAfterDays` is 45 for experts, 90 for brokerages.** A read on the current
  tape ages faster than a twelve-month price target. Past it, show it struck through
  or in a "stale" group — do not silently drop it.
- **`accuracy.insufficient: true` means show the count, not a hit rate.** Below five
  resolved calls a percentage is noise dressed as a measurement.
- **Expert influence is capped at 10 confidence points combined.** When it bites, the
  reason is in `confidence.caps` — render it. Convergence of independent technical
  methods can reach 28; a named human cannot outweigh that no matter how right they
  have been, because the system must not become a channel for one person's opinion.

Live scraping is best-effort and currently returns nothing (anti-bot). `POST
/analysts { symbol, broker, call, target, rationale?, url? }` is the working path,
and a hand-entered call is scored identically to a scraped one.

---

### `GET /ipo/expert-calls` — expert views on IPOs

Ingested from Pravesh's `expert_feed` (`data/latest.json`, schema 2+). **Separate
from `/analysts`**, which is keyed on symbol: an unlisted IPO has no ticker, so
`symbol` is always `null` and the join key is `ipoSlug`.

```json
{ "ok": true, "schemaVersion": 2, "supported": true, "blocked": false,
  "verdict": "checked, no attributable view — the routes that answered carried no explicit stance from these experts",
  "calls": [ { "ipoSlug": "acme-industries", "ipoName": "Acme Industries",
               "symbol": null, "expert": "Sandeep Jain",
               "call": "Subscribe for listing gains", "stanceNormalised": "POSITIVE",
               "url": "…", "seenAt": "2026-08-02T09:00:00Z",
               "capturedAt": "2026-08-03T04:00:00Z", "source": "google_news_rss",
               "target": null, "stop": null } ],
  "coverage": { "issues": 13, "covered": 0 },
  "sourceStatus": [ { "source": "gnews", "routes": [
      { "route": "google_news_rss", "attempted": 4, "answered": 1,
        "hits": 0, "dropped": 0, "reason": "responded 1/4, no matching item" } ] } ],
  "limits": [ "Google News RSS returns headline and summary only …", … ] }
```

**Branch on `certainty`, not on `calls.length`, and never on `ok`.** `ok: true`
coexists with every route 403ing — it means "the fetch succeeded and Pravesh
recorded no failure", and NO_VIEW everywhere is deliberately not a failure.

| `certainty` | meaning | render |
|---|---|---|
| `"full"` | every route answered every query | "no expert view" — a real absence |
| `"per-issue"` | `perIpo[slug]` is authoritative | per issue; **ignore the source-level flags** |
| `"partial"` | some queries went unanswered | "partly checked" — for an issue with no call you cannot say which it was |
| `"none"` | nothing answered (`blocked: true`) | "could not check" — the absence says **nothing** |

`verdict` states the same thing in a sentence; render it verbatim if you need one line.

Under `"per-issue"`, each entry in `perIpo` has its own three-state `status` plus a
ready-made `meaning` sentence, and `perIpoSummary` gives `{ total, checked, partly,
unchecked }`:

| `status` | `meaning` |
|---|---|
| `"checked"` | every expert was asked — an empty result is a real absence |
| `"partly"` | some experts asked, some not — a view from half the panel |
| `"unchecked"` | nothing answered — the absence carries **no** information |

The gap this closes is large, not marginal. On Pravesh's 13-issue run the aggregate
computed `blocked: false` (two experts did answer, on one issue), which would have
rendered "no expert view" for all 13. Per-issue: **1 fully checked, 1 partly, 11 not
checked at all.** Twelve of thirteen would have been wrong.

`"partial"` is the fallback when Pravesh has not published per-issue data. It is the
normal case there, not an edge: Google News RSS rate-limits under
repeated querying and routinely answers 2 of 4 queries. Source-level counts cannot
tell you *which* issues went unasked — only that some did. Until Pravesh publishes
`expert_reachability`, an issue with no call under `"partial"` is genuinely unknown,
and showing it as "no expert view" would launder a rate-limited scraper into an
opinion. That is the failure this endpoint is shaped to prevent, and it survives one
level down from the source-level flag if you branch on `blocked` alone.

Other honest limits, all in `limits[]` and worth surfacing near the calls:

- `call` is **verbatim** and never normalised — `stanceNormalised` is the separate,
  derived field. Show the verbatim words; "Subscribe for listing gains" and
  "Subscribe for the long term" are different instructions.
- `target` and `stop` are **always null**. An expert's IPO call is subscribe or
  avoid, not a level. Do not render an empty target column as though data is missing.
- `seenAt` is publication time and may be `null`; `capturedAt` is when it was
  scraped. They are not interchangeable — staleness is measured from `seenAt`.
- A row without a `url` is dropped before it reaches you. An unattributed call is
  not evidence.

`supported: false` with `schemaVersion: 1` means Pravesh is publishing the old
schema — feature-detect on `schemaVersion >= 2`, never `=== 2`.

---

### Direction-aware pricing

`direction: "buy" | "sell"` is on every playbook, signal, cycle signal and history
record. **The labels ship with the payload — never infer them from a flag.**

| field | buy | sell |
|---|---|---|
| `exits.actionLabel` | `"Entry"` | `"Sell at"` |
| `exits.targetLabel` | `"Target"` | `"Buy back"` |
| target vs price | above | **below** |
| `stop.above` | `false` | `true` |

Every level carries both `pct` (signed) and `movePct` (**magnitude**) plus
`downward`. **Render `movePct` with the arrow, never `pct`.** A trim that captures a
5.5% fall is a 5.5% ▼ win; printing `-5.5%` reads as a loss, and "5.5% upside" on a
sell is simply wrong.

Cycle signals carry a flattened `pricing` block ready to render:

```json
"direction": "sell",
"pricing": { "direction": "sell",
  "actionLabel": "Sell at",  "actionPrice": 9632.5, "actionZone": { "low": …, "high": … },
  "targetLabel": "Buy back", "targetPrice": 9150,   "targetZone": { … },
  "movePct": 5.55, "downward": true, "arrow": "▼",
  "stop": { "price": 10126, "above": true, "rationale": "Above ₹10126, … the trim was early …" },
  "riskReward": 1.23, "confidence": { "score": 65, "band": "moderate" },
  "anchor": "round number + 20-day MA + candlestick" }
```

`pricing` is `null` when no zone could be built — render the signal without prices
rather than inventing them. Sorting a table on potential must use the magnitude, so
buys and sells rank by size rather than sells sorting to the bottom as negatives.

`GET /signals/stats` may also return `excluded`:

```json
"excluded": { "n": 4, "reason": "screener signals filed under a holdings-only profile, …" }
```

Render it as a line under the table when non-null. The totals legitimately shrank,
and a smaller number with no explanation reads as a backend that lost data.

**Track Record reports the two separately.** `GET /signals/stats` returns
`byDirection: { buy: {…}, sell: {…} }`, each with its own `n` and win rate. A sell is
correct when price *fell*, so its return is stored sign-inverted at the point of
recording. Do not merge them into one figure — an average across two different kinds
of bet is not a number about anything.

---

### `GET /cycle-signals`
```json
{ "sell": [ { "id": "cyc_sell_hld_…", "holdingId": "hld_…", "symbol": "POLYCAB",
    "kind": "sell", "direction": "sell", "pricing": { … see Direction-aware pricing … },
    "subtitle": "sell a portion of your holding",
    "criteria": [ { "name": "At resistance", "pass": true, "skipped": false,
                    "detail": "₹9,890 — 52w-high, 0.4% away" } ],
    "holding": { "entryPrice": 7240, "currentPrice": 9890, "gainPct": 36.6,
                 "heldMonths": 4, "stcg": true, "holdingPeriod": { … } },
    "reasoning": "…one sentence with the numbers in it…",
    "suggestion": "consider selling a portion; core stays",
    "reentryRisk": "If it keeps running, buying back may be higher than where you sold.",
    "cycle": { … }, "dataAge": { … } } ],
  "buyBack": [ { "kind": "buyBack", "subtitle": "buy back what you sold",
                 "belowSalePct": -4.2, "sellPrice": 9890, "trendIntact": true, … } ],
  "suppressed": [ { "symbol": "POLYCAB", "kind": "buyBack",
                    "reason": "trend broken — no re-entry signal",
                    "detail": "Price ₹9,056 is below the 50-day average of ₹9,442.51. This is a falling knife, not a pullback." } ] }
```

Kept out of `/exit-signals`, whose `signals[]` already means "a rule fired, consider
exiting fully". `criteria[]` includes failed and skipped entries — three of four is
not four of four.

### `GET /holdings` — every row gains
`cycle` (derived) and `holdingPeriod`:
```json
"cycle": { "status": "partly sold", "sellPrice": 9890, "belowSalePct": -4.23,
           "realisedFromCycle": 6000, "realisedPctFromCycle": 2.27,
           "cycleVsHold": -54000, "qtyKnown": true, "roundTrips": 1,
           "notComparableReason": null, "counterfactualNote": "…" }
"holdingPeriod": { "months": 42, "stcg": false, "measuredFrom": "purchaseDate",
                   "caveat": null }
```

**`cycleVsHold` is rendered wherever `realisedFromCycle` is, same row, same weight.**
Positive means the trimming beat holding; negative means holding would have won.
Verified case: realised **+₹6,000** while `cycleVsHold` is **−₹54,000** — the
flattering number and the honest one point opposite ways, which is exactly when the
comparison matters. `null` with `notComparableReason` when there is no completed
round trip, or no quantity.

`measuredFrom: "markedAt"` carries a `caveat` — render it. A stock marked last week
but held two years reads "0 months · STCG" and argues against a sale that is
actually tax-favourable.

### Actions
```
POST /holdings/:id/sold         { qty?, price? }   → updated holding with cycle
POST /holdings/:id/bought-back  { qty?, price? }   → updated holding with cycle
PATCH /holdings/:id             { purchaseDate }   → fixes the STCG basis
```
Price defaults to the current mark. Quantity is optional; without it rupee figures
are `null` and only percentages are honest (`qtyKnown: false`).

Every cycle signal also carries **`candleReading`** — the context-valid reversal
candle at the level, if one formed — whether or not the `Candles` criterion is
enabled. It is corroboration either way, and its absence is worth seeing.
`buyBack` items carry **`priority: "high" | "normal"`**; high when the holding is
already `partly sold`, since that is the half that closes an open round trip.

### Profiles
`sell_holdings` and `buyback_holdings` arrive in `GET /profiles` with
`appliesTo: "holdings"` — evaluated only for held symbols, and never offered for
unheld ones. `matchesCanonical` still describes the core three, so the drift banner
does not fire because these exist. Verified.
