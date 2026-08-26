# Handoff

Written 26 Aug 2026, at `c564933` on `feat/worker-per-stop-cache` (merged to `main`
as PR #15, `518f0a1`). Covers phases 1–10 of the dynamic-stop-cards work and what
is left.

---

## 1. Where things stand

| | |
|---|---|
| Repo | `hisnameisjoseph/ptv-display` |
| Working branch | `feat/worker-per-stop-cache` @ `c564933` |
| `main` | `518f0a1` — contains everything below |
| Also on origin | `feat/backend_dev` — unrelated to this work, untouched |

**Shipped, phases 1–10:**

- Per-stop Worker cache, `?stops=<routeType>:<stopId>,…`, `/api/search`, mock mode
- User-configurable stop cards: add, remove with undo, reorder, set primary,
  per-card walk filter, per-card route filter
- Density tiers driven by measured card size, landscape grid with page cycling
- Full visual redesign onto a fixed type scale and a fill-based palette
- Pickers as animated bottom sheets

**Not started:** phases 8 and 9 (below).

---

## 2. Running it

```bash
npm install
npm run build:frontend    # tsc → public/app.js
npx wrangler dev          # or: npm run dev
```

**`public/app.js` is a committed build artifact.** Nothing you change in
`src/frontend/app.ts` reaches the browser until you rebuild. Never hand-edit it.
Both typechecks must be silent before you commit:

```bash
npx tsc --noEmit -p src/frontend/tsconfig.json   # frontend
npx tsc --noEmit -p tsconfig.json                # worker
```

### Without PTV credentials

Put `PTV_MOCK=1` in `.dev.vars`. Every upstream call is answered locally by
`src/mock.ts`; D1 lookups, the Flinders Street / Melbourne Central merge, the
per-stop cache and the whole frontend still run exactly as in production.
Scenarios: `normal`, `empty`, `error`, `sparse`, `delay`, `cancel`,
`noestimates` — e.g. `PTV_MOCK=delay`.

Route names and numbers come from D1 even in mock mode, so it is useful with no
fixtures captured at all. `src/fixtures.ts` is a generated stub; run
`node capture-fixtures.mjs` with real credentials to fill it.

---

## 3. Architecture in one screen

```
public/index.html ─┐
public/styles.css  ├── Workers Static Assets (ASSETS binding)
public/app.js ─────┘   compiled from src/frontend/app.ts

src/index.ts           the Worker
  /api/board?stops=…   fan-out per stop, merged response
  /api/search?q=…      unified station + bus stop search
  /api/stations        full station list for the train picker
  /api/stops/search    bus stop search
        │
        ├── caches.default, keyed PER STOP
        └── D1 (binding DB, database ptv-db)
              stations, bus_stops, routes, station_routes, bus_stop_routes
```

**The cache is per stop, not per board.** Upstream load scales with the number of
*unique stops* anyone is watching, not viewers × cards. Two people watching
overlapping boards share every stop they have in common. This is the single most
important property of the backend — do not replace it with a whole-board cache.

Worker constants (`src/index.ts`):

| | |
|---|---|
| `STOP_FRESH_SECONDS` | 45 |
| `STOP_STALE_SECONDS` | 300 — served stale while revalidating via `ctx.waitUntil` |
| `STOP_ERROR_FRESH_SECONDS` | 10 — errors cached briefly so a PTV outage cannot stampede |
| `TRAIN_MAX_RESULTS` / `BUS_MAX_RESULTS` | 16 / 12 |
| `MAX_STOPS` | 8 per board request |
| `MERGE_TYPES` | `flinders_street`, `melbourne_central` — two stop ids, one card |

The board response is `no-store` and carries `staleAtUtc`; only the per-stop
fragments are cached.

Frontend constants (`src/frontend/app.ts`):

| | |
|---|---|
| `REFRESH_MS` | 45 000 |
| `MAX_CARDS` / `WARN_FROM` | 8 / 5 |
| `UNDO_MS` | 7 000 |
| `SPLIT_MIN_WIDTH` | 460 — below this a split card stacks instead of side-by-side |
| `DENSITY_MIN` | comfortable ≥ 620×340, compact ≥ 260×200, else glance |
| `CARD_FLOOR` | 260×130 — below this the landscape grid pages instead of shrinking |
| `CYCLE_MS` | 15 000 — page dwell on the wall board |

Layout lives in `localStorage` under `ptv-layout` (v2):
`{ id, mode, stopId, primary?, collapsed?, walkMinutes?, routeIds? }`.
`migrateLegacyLayout()` converts the old `station`/`bus1`/`bus2` keys; the legacy
query params still work on the Worker.

---

## 4. The design system

Dark palette, Flighty structure. **Do not introduce a value that is not on one of
these ladders** — the verification harness asserts it.

### Neutrals — fill, never border

```
--bg          #000000   the board
--bg-raised   #121212   cards, sheets
--bg-sunken   #0a0a0a   inputs
--bg-band     #181818   column headers, edit bar, chips
--selected    #242424
--hairline    #232323   the ONLY line in the system, and only ever a divider
--fg          #ffffff  --fg-secondary #8b8b8b  --fg-tertiary #737373
```

Cards have no border. Separation is a lighter black on black. A divider is always
inset past the rail or the glyph, never full-bleed across a row.

Brand and status are unchanged from the original board: `--amber #ffb300`
(countdown), `--live #37c978`, `--train #2a6fb8`, `--bus #e07020`,
`--late #ea4d3c`.

### Type — nine roles, nothing between them

| role | size | used for |
|---|---|---|
| display | 34 / 1.05 / 700 | countdown numeral, comfortable |
| title-2 | 22 / 28 / 700 | destination, board title, sheet title |
| headline | 17 / 22 / 600 | card header, result rows |
| body | 17 / 22 / 400 | |
| subheadline | 15 / 20 / 400 | |
| footnote | 13 / 18 / 400 | row metadata |
| overline | 12 / 16 / 600 / +0.6px / caps | direction bands, units, eyebrows |
| caption | 11 / 14 / 500 | compact units |

**Density steps down a rung; it never invents a size.** Destination 22 → 17,
countdown 34 → 22. Nothing shrinks below 17. Below that the board sheds metadata
instead — that is what `glance` does, and at glance the unit also moves beside the
numeral rather than under it, which is where the height for a second direction
comes from.

Icon glyphs are on the scale too — pencil 17, chevrons 15 and 12.

### Radius and spacing

Radius: **6** badge, **14** input, **16** banner, **20** card, **28**, **36**
sheet, **full** for anything interactive and inline. Nothing else.

Spacing: 4px grid. Two gutters only — **20px** at the root (`--pad`), **16px**
inside cards.

### Row anatomy

```
[ rail: numeral over overline unit ] [ badge  destination        ]
                                     [ Platform 5 · Live · 16:31 ]
```

The countdown is the largest thing in the row because it is the thing being read.
`sizeRail()` widens the rail per card after mount, so a daytime board keeps a
narrow rail and gives the width to the destination, and only hour-scale cards pay.

A late service says so: `4 min late` in red with the superseded time struck
through. Status is colour **and** word, never colour alone.

### Two measured numbers, do not "tidy" them

- **`--row-pad-x: 8px` at compact.** A split column is 237px at phone-landscape
  sizes and "Flinders Street" needs 141 of them. At 12px it was 4px short and
  ellipsized every city-bound row.
- **`SPLIT_MIN_WIDTH = 460`.** Calibrated to where a long destination starts to
  truncate in a side-by-side split.

---

## 5. Decisions already made

Settled — please do not re-open without a reason:

| Decision | Why |
|---|---|
| Light mode overridden | The palette stays dark. Flighty's neutral ladder is inverted, not dropped. |
| No clock, no "updated" line, no status dot | Deliberate. The owner does not want a staleness signal; a stale board keeps showing the last payload, and rows carry absolute times. |
| Countdown rail on the left | Follows `Row.data`; the number wins the row. |
| Bus route badges stay orange | Mode signal, i.e. data, not decoration. A knowing deviation from "one accent per screen". |
| Terminus band reads `ALL SERVICES` | `TO CITY` would be a lie at Frankston, which also runs to Stony Point. |
| Bus cards get no band | Trains only. Accepted inconsistency on mixed boards. |
| Edit buttons are 44×41, not 44×44 | The cost of keeping the edit bar at its original 41px height. |
| Sheet padding uses `--pad-left/right`, not 16px | Aligning with the cards behind it beats the Flighty rule. |
| Walk/route chip hidden on collapsed cards | The stop name needs the width. It returns on expand, and the summary is computed from the filtered list, so nothing is silently inconsistent. |
| Long countdowns become `4h` / `39 m` | Past an hour a third digit overflowed the rail, and nobody plans around 279 minutes. |

---

## 6. Outstanding work

### 6.0 — Known gap, fix first (small)

**Portrait terminus cards have no `ALL SERVICES` band.** The band was added to
`buildTrainGrid` (landscape) but not to `buildTrainStacked` (portrait), so an
Alamein or Sandringham card still opens with a bare row in portrait while the
same card in landscape has the band. Verified 26 Aug: landscape `bands: ["All
services"]`, portrait `bands: []`.

In `buildTrainStacked`, after `section.appendChild(rowsWrap);`, add:

```ts
if (!split) rowsWrap.appendChild(el("h3", undefined, "All services"));
```

The CSS already covers it — `.col h3, .rows > h3` is in place.

> The band is a direct child of `.rows`, **not** wrapped in a `.col`, on purpose.
> `trimOverflow()` only treats a card as column-based when `.rows` carries `split`
> or `stacked-split`; an unsplit card carries neither, so a `.col` would be deleted
> whole. As a plain first child the `<h3>` sits ahead of every row and trimming
> removes rows from the end as intended.

### 6.1 — Phase 8: polling discipline

Currently `init()` does `setInterval(refresh, REFRESH_MS)` unconditionally and
`visibilitychange` only re-requests the wake lock. So a backgrounded tab keeps
polling every 45s forever, and a tab returning to the foreground shows stale data
until the next tick.

Scope:

- Pause the interval while `document.visibilityState === "hidden"`
- On becoming visible, refresh **once** if the payload is past `staleAtUtc`
  (already present on the response, currently unused by the frontend)
- Guard against overlapping requests with an in-flight flag — a visibility burst
  previously produced five simultaneous fetches
- Consider backing off after repeated failures

Nothing of this exists in the tree; earlier scratch work predates the redesign and
is not reusable.

### 6.2 — Phase 9: README and rate limiting

- **Rewrite `README.md`.** The "Product decisions" section still says *"Bus stops
  are two fixed slots, not an arbitrary list"* — that has been false since phase 7.
  The Architecture section predates the per-stop cache. Screenshots are all of the
  old design.
- **Add a Cloudflare WAF rate-limit rule** on `/api/*`. The per-stop cache protects
  PTV from *load*, but nothing currently protects the Worker from a single abusive
  client.

### 6.3 — Open, unreproduced

**iOS blur.** The owner reports the header looking blurred on iPhone 16 Pro,
iOS 26 beta 5. There is no `blur` or `backdrop-filter` anywhere in `styles.css`,
and it is visible in a screenshot predating the redesign. Best guess is the iOS 26
scroll-edge effect interacting with `viewport-fit=cover` plus
`apple-mobile-web-app-status-bar-style: black-translucent` in `index.html` —
a guess, not a diagnosis. Needs on-device testing: Safari tab vs Home Screen app,
with and without Reduce Transparency, scrolled to top vs scrolled down.

---

## 7. How to verify a change

There is no test suite. Everything so far has been verified with **Playwright plus
a stub API server**, and every layout number in the codebase was measured rather
than chosen. Recreating that harness is worth the twenty minutes.

Chromium is pre-installed in Claude Code's remote environment at
`/opt/pw-browsers/chromium`; locally, `npx playwright install chromium`.

**Stub server.** A ~40-line `node:http` server that serves `public/` and answers
`/api/board`, `/api/search`, `/api/stations` and `/api/stops/search` with fixed
data. Departure times generated as offsets from `Date.now()` so countdowns behave.
Include at least one `stationType: "terminus"` stop and one merged
(`flinders_street`) stop — those are the two cases that break.

**Seed the layout** before navigation, or the board renders defaults:

```js
await page.addInitScript(
  (cards) => localStorage.setItem("ptv-layout", JSON.stringify({ version: 2, cards })),
  [{ id: "a", mode: "train", stopId: 1072, primary: true },
   { id: "b", mode: "train", stopId: 1074 }],
);
```

**Simulate iOS safe-area insets — this is not optional.** Chromium resolves
`env(safe-area-inset-*)` to 0, so landscape bugs simply do not appear without it.
iPhone 16 Pro landscape insets 59pt on each long edge and 21pt at the home
indicator, and those 118px are what shrink cards into the failing range:

```js
await page.addStyleTag({
  content: ":root{--pad-left:59px;--pad-right:59px;--pad-bottom:21px}",
});
```

**Sizes that have caught real bugs:**

| viewport | what it catches |
|---|---|
| 402×874 | iPhone 16 Pro portrait |
| 393×852 | iPhone 15 Pro portrait |
| 874×402 | 16 Pro landscape, Home Screen app |
| **874×330** | 16 Pro landscape **with the Safari toolbar** — the harshest case; a card went completely empty here and nowhere else |
| 956×440 | 16 Pro Max landscape |
| 844×390 | 14 Pro landscape |
| 1280×800 | desktop / wall board |

**Assertions worth keeping:**

- No card renders zero rows unless it is collapsed
- Every split card shows **2** `.col` elements, not 1
- No `.dest .name` or `.meta` has `scrollWidth > clientWidth`
- `document.documentElement.scrollWidth <= viewport.width`
- No console errors or page errors
- **Every rendered text node's computed `font-size` is one of
  `11, 12, 13, 15, 17, 22, 34`** — this is what makes the type scale a property
  rather than a claim
- No menu or sheet cropped by an ancestor. `getBoundingClientRect()` ignores
  ancestor clipping — walk up the tree for a non-`visible` `overflow` and compare
  edges. A 76px crop hid behind a passing rect check once already.

---

## 8. Gotchas

- **`public/app.js` is committed.** Rebuild after every `app.ts` change.
- **`render()` empties `#board` on every pass.** Anything that must survive a
  render — the bottom sheet — is mounted on `document.body` and reconciled by
  `syncSheet()`, which touches the DOM only when the mounted sheet disagrees with
  the state. That is what keeps the caret in the search field.
- **`trimOverflow()` tests for both `split` and `stacked-split`.** Testing only
  `split` silently deleted whole direction columns; a card went entirely blank at
  874×330. If you add another rows variant, add it there too.
- **`cardObserver` must skip detached sections.** A rebuild reports old sections as
  0×0 on the way out; measuring that overwrites a good reading and bounces the
  split state into a render loop (178 rebuilds in 3 idle seconds, once).
- **`sizeRail()` reads layout during render** — one forced reflow per card. It can
  also over-size for a frame on first paint, when a card has no measured size yet
  and uses comfortable-tier fonts. It only ever over-sizes, never under-sizes.
- **CSS specificity.** `.body .meta > span + span::before` is (0,2,3). An override
  written at (0,2,2) loses and leaves a stray leading separator. Match or beat it.
- **`section { overflow: hidden }`** keeps rows inside the rounded corners. It also
  clipped the old dropdown picker; that is gone now, but anything else that needs
  to escape a card has the same problem.
