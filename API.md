# Trinetra backend — API contract

For anyone building the dashboard against this backend. Shapes here are what the
server actually returns; where a shape changed recently it says so, because the
dashboard predates several of these.

Base URL is whatever `NEXT_PUBLIC_BACKEND_URL` points at. Every route is subject
to `UI_ORIGIN` CORS (defaults to `*`; production should name the dashboard
origin).

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
