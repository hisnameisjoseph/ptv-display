# Melbourne Departures Board

A real-time public transport departures board for Melbourne, built as a live PIDS-style display (the kind you see hanging over train platforms). It shows upcoming train and bus departures for a chosen train station, updates every 45 seconds, and adapts its layout from a phone screen to a wall-mounted display.

Built with TypeScript on Cloudflare Workers and Pages, running entirely on free tiers with no ongoing hosting cost.

**Live demo:** _[add your workers.dev URL here]_

_[add a screenshot or two here — the landscape board and the phone view make a strong first impression]_

---

## What it does

- Fetches live departures from the Public Transport Victoria (PTV) Timetable API and displays them as a clean, glanceable board.
- Splits train departures by direction of travel (for example, citybound vs outbound), with per-station logic that reflects how Melbourne's network actually runs.
- Applies official Melbourne Metro line colours to each service so the board is readable at a glance.
- Adapts responsively: a two-column ambient board in landscape (for an always-on wall display), and a compact decision-focused view in portrait (for checking on a phone before leaving the house).
- Runs as an installable web app (PWA) on a spare phone for a permanent, low-power departure display.

## Why I built it

I live near Footscray Station and wanted a genuinely useful home display, but I also wanted a project that exercised the parts of backend and cloud engineering I care about: integrating a real third-party API, handling authentication and caching correctly, and making pragmatic product decisions when the data doesn't behave the way you'd like. It has been a deliberately iterative build, shaped by real-world constraints rather than a fixed spec.

## Architecture

The whole system is two deployables on Cloudflare's free tier.

**Backend — Cloudflare Worker (TypeScript)**
- Signs every PTV API request with HMAC-SHA1 using the Web Crypto API, as required by PTV's authentication scheme.
- Fetches multiple stops in parallel and merges them into a single, slim JSON payload so the frontend makes just one request.
- Caches each station's response at the edge for 45 seconds, so many viewers (or frequent refreshes) collapse into a single upstream API call. This keeps the board well within PTV's rate limits.
- Exposes a simple `GET /api/board?station=<key>` endpoint with open CORS, so other clients (a future hardware display, for example) can reuse the same data.

**Frontend — static page on Cloudflare Pages**
- A single-page app that renders the board, auto-refreshes, and re-computes countdowns between fetches so the times stay honest.
- A station registry maps friendly keys to PTV stop IDs, including physically-paired stations (such as Flinders Street + Town Hall) whose departures are merged.
- Per-station display rules control direction-splitting, since a citybound train at a suburban station and a through-running train at a Metro Tunnel station need different handling.
- Persists the selected station and display preferences per device in local storage, so a wall display and a phone can show different stations independently.

## Engineering details worth calling out

**Request signing.** PTV's API requires an HMAC-SHA1 signature over the request path. Implementing this correctly in the Cloudflare Workers runtime meant using the Web Crypto API rather than Node's `crypto` module, since Workers run on a different runtime than Node.

**Timezone correctness.** The API returns all times in UTC. Melbourne observes daylight saving, so all display times and countdowns are computed in the `Australia/Melbourne` timezone rather than by naive offset. Getting this right end-to-end is the kind of detail that quietly breaks a board twice a year if you don't handle it deliberately.

**Caching strategy.** Rather than every client polling PTV directly, the Worker acts as a caching proxy at the edge. This decouples client refresh frequency from upstream API usage and is what makes the "free tier, no ongoing cost" constraint achievable.

**Direction-splitting.** Deciding which column a departure belongs to turned out to be a real domain problem. Melbourne's City Loop reverses direction at different times of day, and destination names alone don't reliably indicate direction. I worked through this by classifying services using stable properties (route/line membership) rather than time-dependent ones, with per-station configuration where the network geography differs.

**Layout that fills the space honestly.** The board renders as many departures as fit the screen, then measures and trims any row that would be clipped, so the display is always full but never shows a half-cut row. It re-fits on resize and orientation change.

## Tech stack

- **Language:** TypeScript (backend), vanilla JavaScript, HTML, CSS (frontend)
- **Platform:** Cloudflare Workers (serverless API) + Cloudflare Pages (static hosting)
- **APIs:** Public Transport Victoria (PTV) Timetable API v3
- **Web platform features:** Web Crypto API (request signing), Screen Wake Lock API (always-on display), local storage (per-device settings), PWA install
- **Tooling:** Wrangler CLI, Git-based continuous deployment

## Product decisions

A few choices where I chose the honest option over the impressive-sounding one:

- **Removed V/Line services after integrating them.** V/Line departures were available from the API, but the data was too sparse for a dependable display: no real-time estimates, inconsistent platform information, and undocumented fields. Rather than ship something misleading, I cut the feature. Investigating an undocumented `flags` field (by cross-referencing two API endpoints) was a useful exercise in reasoning about unclear third-party behaviour.
- **Kept the design minimal at small sizes.** On a small display, line colour plus destination plus a countdown communicates more than a row crowded with platform numbers and status text. I stripped metadata deliberately where screen space was scarce.

## Roadmap

The project is deployed and working. Planned directions:

- **Hardware display.** Driving a small networked screen (a GeekMagic SmallTV) or an e-ink panel from the existing API, via a lightweight image renderer.
- **Departures data warehouse.** Logging scheduled vs actual departure times into a proper relational schema (stations, routes, departures) to build a historical dataset.
- **Delay analysis and prediction.** Using that dataset to analyse recurring delays and explore a simple predictive model for which services tend to run late.
- **Customisable stations.** Currently, limited train stations have been listed in the drop down menu. After building backend I can add all the stations in the drop down menu with search bar. Options for bus stations will be added in the following stage.

## Running it yourself

_[This section assumes the reader has their own PTV API credentials. Adjust paths to match your repo layout.]_

```bash
# Install dependencies
npm install

# Add your PTV credentials for local development (never commit this file)
cp .dev.vars.example .dev.vars
# then edit .dev.vars with your PTV_DEV_ID and PTV_API_KEY

# Run locally
npm run dev

# Deploy to Cloudflare
npx wrangler secret put PTV_DEV_ID
npx wrangler secret put PTV_API_KEY
npm run deploy
```

PTV API credentials are free and can be requested from Public Transport Victoria.

---

_Built by Joseph. Feedback and questions welcome._