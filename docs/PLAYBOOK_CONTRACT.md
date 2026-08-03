# Playbook — what the backend will serve

Written before implementation so the dashboard can be built in parallel. Status:
**proposed**. `API.md` becomes authoritative the moment the endpoints land; if the
two disagree, `API.md` wins.

The tab answers four questions per stock: where to get in, where it is now,
where to get out, what is left — each level backed by named, inspectable
evidence.

---

## The organising idea, and what it means for the UI

A level is only as good as **the number of independent methods that agree on
it**. Four methods converging near ₹1,268 is a real level. The same four
scattered across ₹1,180–₹1,420 is *no level*, and the payload will say so rather
than pick one.

Three consequences the UI has to honour:

1. **Levels are zones, never single prices.** Every entry and exit carries
   `{ low, high }` sized by ATR. Rendering `₹1,268` where the payload says
   `₹1,254–1,281` invents precision the data does not have.
2. **`convergence: 0` is a first-class state**, not an error and not an empty
   panel. It means the methods disagree, which is information: "no level here —
   four methods, no agreement."
3. **Opposing evidence renders.** Every evidence item has
   `stance: "supports" | "opposes" | "neutral"`. A list showing only supporting
   items is marketing. If two brokers target below the current price, that shows.

---

## Endpoints

### `GET /playbook?symbol=&profile=`
```json
{ "symbol": "POLYCAB", "profileId": "swing", "horizon": "swing",
  "price": 9100, "asOf": 0, "dataAge": { "delayed": true, "lagSeconds": 900 },

  "entry": {
    "kind": "breakout trigger" | "pullback entry",
    "zone": { "low": 9180, "high": 9240 },
    "triggered": false,
    "chasing": false,
    "chaseRiskPct": null,
    "movedAlreadyPct": -0.9,
    "convergence": 3,
    "anchors": [ { "name": "20-day high cluster", "price": 9200, "type": "resistance" } ],
    "confidence": { "score": 61, "band": "moderate", "components": [ … ], "caps": [ … ],
                    "summary": "…" },
    "evidence": [ … ]
  },

  "exits": {
    "safe":    { "zone": { "low": 9520, "high": 9580 }, "pct": 5.0, "anchor": "50-day high",
                 "convergence": 2, "evidence": [ … ] },
    "primary": { … },
    "stretch": { … },
    "stop":    { "zone": { … }, "pct": -3.1, "anchor": "below the 20-day low",
                 "rationale": "structure, not an arbitrary percentage" },
    "riskReward": { "toSafe": 1.6, "toPrimary": 2.4, "toStretch": 3.1 },
    "riskRewardWarning": null,
    "confidence": { … }
  },

  "potential": {
    "toSafePct": 4.6, "toPrimaryPct": 9.2, "toStretchPct": 14.0,
    "movedAlreadyPct": 3.1, "exhausted": false
  },

  "candles": { "detected": [ … ] },
  "analysts": { "consensusTarget": 9800, "n": 14, "calls": [ … ], "unavailable": false },
  "reading": "One-sentence plain-English summary."
}
```

### `GET /playbook/all?profile=`
Compact, one row per watchlist symbol, for the table view: `symbol`, `price`,
`entry.zone`, `entry.kind`, `entry.confidence.score`, `exits.primary.zone`,
`potential.toPrimaryPct`, `exits.confidence.score`, `convergence`, `reading`.
No evidence arrays — those come from the per-symbol call when a row is opened.

### `GET /analysts?symbol=`
Broker calls with targets, dates, source URLs, and each broker's measured hit
rate. Cached hard; scraped slowly.

---

## The evidence item — the heart of the tab

```json
{ "source": "Technical" | "Broker" | "Candlestick" | "Analog" | "Fundamental",
  "name": "20-day high cluster",
  "stance": "supports",
  "detail": "Touched 4 times since March, last held 6 sessions ago",
  "weight": 0.8,
  "reliability": { "rate": 64, "n": 22 } | null,
  "url": "https://…" | null }
```

`reliability` is **null when it cannot be measured**, which is different from
zero. Render "insufficient history", never "0%".

---

## The thing that will most affect how this looks: it starts empty

Almost every reliability figure is measured, not asserted — and measurement takes
time. **Design for the empty state first, because it is the state the tab will be
in for months:**

- **Broker hit rates** need calls to *resolve* (did price reach the target within
  ~6 months?). On day one every broker reads `insufficient history`, and the
  first real rate appears no earlier than ~6 months from the first scrape, and
  only once n ≥ 5.
- **Candlestick follow-through** is measured per pattern **per stock**, from that
  stock's own history — not a textbook table. Patterns with fewer than 8
  occurrences in the available history report `insufficient history` rather than
  a rate. Many symbols will never reach 8 for the rarer patterns.
- **Analog counts** already behave this way (`n < 8` → no numeric range).

So the honest tab, at launch, is mostly named levels and convergence counts with
"reliability: not yet measurable" beside them. That is the correct appearance,
not a degraded one. A design that only looks right once every rate is populated
will look broken for its first six months and will tempt someone to fill the gap
with a textbook number — which is exactly what this feature is built to avoid.

---

## Constraints I would rather state now than have you discover

- **Broker scraping is the fragile part.** Moneycontrol and the rest change
  markup and rate-limit; one has already served us a bot-check page instead of
  data on a different feature. `analysts.unavailable: true` is a normal response,
  not an outage — the tab must stand without it, showing technical and
  candlestick evidence alone.
- **Stale calls are excluded from levels but still shown.** A target from last
  year is history, not a view: it appears in the evidence list with its age and
  `stale: true`, and does not move any level.
- **A pattern without context is not evidence.** A hammer in mid-range is noise;
  only `contextValid: true` detections reach the evidence list. Do not render the
  raw `candles.detected` array as findings — it includes invalidated ones for
  transparency.
- **The delayed-feed confidence cap still applies** (65 on any delayed feed, 55
  for intraday). Entry and exit confidence carry `caps[]` for the same reason
  every other score does.
- **Two years of daily history is the ceiling** on what the levels engine sees.
  A 52-week high is solid; an "all-time high" is only as old as the data.

---

## Timing

Do not bind until this lands and `API.md` is updated — the shapes above are my
intent, not a promise. I will flag any field that changed between this note and
the implementation, the way the `decisions` / `decision` naming got resolved last
time.
