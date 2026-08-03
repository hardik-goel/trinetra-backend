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
