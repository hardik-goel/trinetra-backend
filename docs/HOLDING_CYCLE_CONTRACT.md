# Trading around a core holding — what the backend will serve

Written before implementation so the Positions work can start in parallel.
Status: **proposed**. `API.md` becomes authoritative when the endpoints land.

## What this is, and the one thing it must never become

The user holds stocks he intends to keep, and wants to ride the waves inside them:
sell a portion near a local top, buy it back lower, core position untouched. He
never goes net-short.

So a holdings **SELL is not a short**, and it is not the existing exit alert. Four
messages now carry BUY/SELL vocabulary and each must be distinguishable at a
glance — the **subtitle is the only thing separating them** and is mandatory,
never truncated, never abbreviated:

| header | subtitle | meaning |
|---|---|---|
| `👁 BUY` | *new position* | existing entry signal, stock not held |
| `👁 BUY` | *buy back what you sold* | re-accumulate after a trim |
| `💰 SELL` | *sell a portion of your holding* | lighten near a local top |
| `⚠ CLOSE POSITION` | — | the thesis broke; exit fully |

Confusing "sell a portion" with "close the position" costs the user a position he
meant to keep. That is the failure mode this contract exists to prevent.

**A holdings SELL is emitted only for symbols in `holdings`.** Never for an unheld
stock — that would be a short recommendation, which is out of scope.

---

## Two new profiles

They arrive in `GET /profiles` like any other, so the criteria panel edits them
with no special-casing:

```json
"sell_holdings":    { "name": "Sell — holdings",    "horizon": "swing",
                      "appliesTo": "holdings", "criteria": [ … ] }
"buyback_holdings": { "name": "Buy back — holdings", "horizon": "swing",
                      "appliesTo": "holdings", "criteria": [ … ] }
```

`appliesTo: "holdings"` is new. A profile carrying it is evaluated **only** for
held symbols — the watchlist must not render these columns for unheld stocks.

New metrics in the catalog, all selectable and editable like existing ones:
`extensionVs20dma`, `extensionVs50dma`, `rsi14`, `atResistancePct`,
`gainVsAnalogMedian`, `volumeClimax`, `gainVsHoldingEntry`, `pullbackToSupportPct`,
`rsiRecovery`, `trendIntact`, `volumeDryUpThenExpansion`, `retraceVsSalePrice`.

---

## Cycle state, on every holding

```json
{ "id": "hld_…", "symbol": "POLYCAB",
  "cycle": {
    "status": "full" | "partly sold" | "restored",
    "coreQty": 100, "soldQty": 30,
    "sellPrice": 9890, "soldAt": "2026-08-03T…",
    "boughtBackQty": null, "buyBackPrice": null, "boughtBackAt": null,
    "belowSalePct": 4.2,
    "realisedFromCycle": 1240,
    "cycleVsHold": -310,
    "completedCycles": 2
  } }
```

One-tap, no forms — the user will not fill one in:

```
POST /holdings/:id/sold         { qty?, price? }   → defaults to current price
POST /holdings/:id/bought-back  { qty?, price? }
```

---

## The number that must never appear alone

**`cycleVsHold` is displayed wherever `realisedFromCycle` is displayed, at the same
visual weight.** Not behind a tap, not smaller, not in a tooltip.

Trading around a core position frequently underperforms simply holding it. If the
UI shows "made ₹1,240 from trimming" without "₹310 worse than doing nothing", it
teaches the user that the activity is working when his own data says otherwise —
and that is precisely the self-deception this whole app is built to prevent.

Sign convention: **positive means the trimming beat holding**, negative means
holding would have been better.

---

## Two honest limits you will hit while rendering

**1. Rupee figures need a quantity, and one-tap holdings have none.**
`POST /holdings {symbol}` records no `qty` by design. Without it,
`realisedFromCycle` and `cycleVsHold` can only be expressed as **percentages**;
both come back `null` in rupees with `qtyKnown: false`. Render the percentage form
and, if you want the rupee form, prompt for quantity at the point of "I sold some"
rather than up front.

**2. The holding period is measured from when it was marked here.**
`markedAt` is when the user tapped "I'm holding this", which may be long after he
actually bought. So the STCG flag is only as good as that date:

```json
"holdingPeriod": { "months": 4, "underTwelveMonths": true,
                   "measuredFrom": "markedAt" | "entryDate",
                   "caveat": "measured from when this was marked in Trinetra, which may be later than the actual purchase" }
```

When `measuredFrom` is `"markedAt"`, **render the caveat** — a confident "held 4
months" that is actually 4 months *since the user started tracking it* could push
someone into realising STCG on a holding that was already long-term. Offering an
editable purchase date on the holding card fixes it properly.

The flag states the timing consequence only. This is not a tax tool and computes
no liability; rates and rules change and the README says to confirm them.

---

## Alert payload additions

Setup signals gain:

```json
{ "kind": "entry" | "sell_holding" | "buy_back",
  "subtitle": "sell a portion of your holding",
  "holding": { "entryPrice": 7240, "currentPrice": 9890, "gainPct": 36.6,
               "holdingPeriod": { … } },
  "reEntryRisk": "If it keeps running, buying back may be higher.",
  "belowSalePct": 4.2 }
```

`subtitle` and `reEntryRisk` are server-supplied strings meant to be rendered
verbatim. `kind` is what you should branch on — not the header text.

**Buy-back is suppressed when the trend has broken**, and says so rather than
going quiet:

```json
{ "suppressed": true, "reason": "trend broken — no re-entry signal",
  "detail": "Price is below the 50-day average; this is a falling knife, not a pullback." }
```

Render that reason on the holding card. Silence would read as "no signal yet"
when it actually means "deliberately withheld".

---

## Delivery rules already in force

Market-hours gate, edge-triggering, per-symbol cooldown, durable dedupe and rate
limits all apply unchanged. One exception: **`MIN_POTENTIAL_PCT` does not suppress
a holdings SELL** — an exhaustion signal on a large position is material even when
the remaining percentage is small.

---

## Timing

Do not bind until this lands and `API.md` is updated. Field names above are intent,
not a promise; anything that changes on the way in will be flagged the way the
`decisions` / `decision` naming was.
