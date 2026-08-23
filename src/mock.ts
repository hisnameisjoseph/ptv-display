/**
 * Departures without PTV credentials.
 *
 * Set PTV_MOCK in .dev.vars and every upstream call is answered locally
 * instead. Only fetchDepartures() is intercepted, so everything downstream —
 * D1 lookups, the Flinders Street / Melbourne Central merge, the per-stop
 * cache, the whole frontend — runs exactly as it does in production.
 *
 * Two sources, in priority order:
 *
 *   1. A capture in src/fixtures.ts, if one exists for the stop. Real route
 *      names, real direction names, real platforms, real irregular gaps.
 *   2. Otherwise a timetable generated from the routes D1 already holds for
 *      that stop. Route names and numbers are therefore real even here; only
 *      the destinations, platforms and headways are synthesised.
 *
 * Because (2) covers every stop in the database, mock mode is useful with no
 * fixtures captured at all.
 *
 * Times are anchored to the wall clock rather than to the moment of the
 * request, so countdowns tick down between refreshes instead of resetting to
 * the same numbers every time the board reloads.
 */

import type {Departure} from "./index";
import { FIXTURES, type FixtureStop } from "./fixtures";

// ---- Scenarios -------------------------------------------------------------

export type MockScenario =
  | "normal"
  | "empty"
  | "error"
  | "sparse"
  | "delay"
  | "cancel"
  | "noestimates";

const SCENARIOS = new Set<string>([
  "normal",
  "empty",
  "error",
  "sparse",
  "delay",
  "cancel",
  "noestimates",
]);

/**
 * Reads the PTV_MOCK binding. Returns null when mock mode is off, which is the
 * only thing the Worker needs to branch on.
 *
 *   PTV_MOCK=1        -> normal
 *   PTV_MOCK=delay    -> every service running late
 *   PTV_MOCK=          -> off
 */
export function parseScenario(raw: string | undefined): MockScenario | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "off") return null;
  if (SCENARIOS.has(v)) return v as MockScenario;
  return "normal";
}

// ---- Determinism -----------------------------------------------------------

// Seeded from the stop id, so a given stop looks the same on every request and
// across restarts. Without this the board reshuffles every 45 seconds and a
// real bug is indistinguishable from noise.
function seededRandom(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pickInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

// ---- Schedules -------------------------------------------------------------

/**
 * A service every `headwaySec`, phase-locked to the Unix epoch. Anchoring to
 * the clock rather than to "now" is what makes the countdown behave: the same
 * departure keeps the same absolute time between requests, so it counts down.
 */
function series(headwaySec: number, phaseSec: number, nowMs: number, horizonSec: number): number[] {
  const nowSec = Math.floor(nowMs / 1000);
  const phase = ((phaseSec % headwaySec) + headwaySec) % headwaySec;
  let t = Math.ceil((nowSec - phase) / headwaySec) * headwaySec + phase;
  const out: number[] = [];
  while (t < nowSec + horizonSec) {
    if (t > nowSec) out.push(t * 1000);
    t += headwaySec;
  }
  return out;
}

/**
 * Replays a captured pattern as a repeating cycle, so the fixture never runs
 * out of future departures however long the board is left running.
 */
function fixtureTimes(offsets: number[], nowMs: number, wanted: number): number[] {
  if (offsets.length === 0) return [];
  const base = offsets[0];
  const rel = offsets.map((o) => o - base);
  const span = rel[rel.length - 1];
  const firstGap = rel.length > 1 ? rel[1] : 360;
  const cycle = Math.max(span + firstGap, 60);

  const nowSec = Math.floor(nowMs / 1000);
  const anchor = Math.floor(nowSec / cycle) * cycle;

  const out: number[] = [];
  for (let k = 0; k < 6; k++) {
    for (const r of rel) {
      const t = anchor + k * cycle + r;
      if (t > nowSec) out.push(t * 1000);
    }
  }
  out.sort((a, b) => a - b);
  return out.slice(0, wanted);
}

// ---- Fixture replay --------------------------------------------------------

function fromFixture(
  fixture: FixtureStop,
  nowMs: number,
  maxResults: number,
): { departures: Departure[]; stopName: string } {
  const offsets = fixture.departures.map((d) => d.offsetSeconds);
  const times = fixtureTimes(offsets, nowMs, maxResults);

  const departures: Departure[] = times.map((t, i) => {
    // The cycle repeats, so index back into the captured pattern.
    const src = fixture.departures[i % fixture.departures.length];
    return {
      route: src.route,
      routeId: src.routeId,
      destination: src.destination,
      platform: src.platform,
      scheduledUtc: new Date(t).toISOString(),
      estimatedUtc:
        src.estimateDeltaSeconds === null
          ? null
          : new Date(t + src.estimateDeltaSeconds * 1000).toISOString(),
    };
  });

  return { departures, stopName: fixture.stopName };
}

// ---- Generated timetable ---------------------------------------------------

interface MockRouteRow {
  route_id: number;
  name: string;
  number: string | null;
}

async function routesForStop(
  db: D1Database,
  routeType: number,
  stopId: number,
): Promise<MockRouteRow[]> {
  const table = routeType === 0 ? "station_routes" : "bus_stop_routes";
  try {
    const { results } = await db.prepare(
      `SELECT r.route_id, r.name, r.number
         FROM ${table} sr
         JOIN routes r ON r.route_id = sr.route_id
        WHERE sr.stop_id = ?
        ORDER BY r.route_id`,
    ).bind(stopId).all<MockRouteRow>();
    return results;
  } catch {
    return [];
  }
}

async function stopNameFor(
  db: D1Database,
  routeType: number,
  stopId: number,
): Promise<string> {
  const table = routeType === 0 ? "stations" : "bus_stops";
  try {
    const row = await db.prepare(
      `SELECT name FROM ${table} WHERE stop_id = ?`,
    ).bind(stopId).first<{ name: string }>();
    return row?.name ?? `Stop ${stopId}`;
  } catch {
    return `Stop ${stopId}`;
  }
}

async function generate(
  db: D1Database,
  routeType: number,
  stopId: number,
  maxResults: number,
  nowMs: number,
): Promise<{ departures: Departure[]; stopName: string }> {
  const [routes, stopName] = await Promise.all([
    routesForStop(db, routeType, stopId),
    stopNameFor(db, routeType, stopId),
  ]);

  const usable: MockRouteRow[] =
    routes.length > 0
      ? routes
      : [
          routeType === 0
            ? { route_id: -1, name: "Metro", number: null }
            : { route_id: -1, name: "Local Service", number: "000" },
        ];

  const rnd = seededRandom(stopId);
  const isTrain = routeType === 0;
  const horizon = 90 * 60;
  const out: Departure[] = [];

  usable.forEach((route, routeIdx) => {
    // Trains run both ways from a platform; a bus stop is one pole, one
    // direction, which is why bus cards need no split logic anywhere.
    const directions = isTrain
      ? [
          { destination: "Flinders Street", platform: String(1 + ((routeIdx * 2) % 14)) },
          { destination: route.name, platform: String(2 + ((routeIdx * 2) % 14)) },
        ]
      : [{ destination: route.name, platform: null }];

    for (const dir of directions) {
      const headway = pickInt(rnd, isTrain ? 5 : 8, isTrain ? 14 : 22) * 60;
      const phase = pickInt(rnd, 0, headway - 1);

      for (const t of series(headway, phase, nowMs, horizon)) {
        // Most services have a live estimate; some are timetable-only, which
        // is what exercises the "Scheduled" path on a row.
        const hasEstimate = rnd() < 0.75;
        const drift = hasEstimate ? pickInt(rnd, -60, 180) : 0;
        out.push({
          route: route.number || route.name || "?",
          routeId: route.route_id,
          destination: dir.destination,
          platform: dir.platform,
          scheduledUtc: new Date(t).toISOString(),
          estimatedUtc: hasEstimate ? new Date(t + drift * 1000).toISOString() : null,
        });
      }
    }
  });

  out.sort(
    (a, b) =>
      new Date(a.estimatedUtc ?? a.scheduledUtc).getTime() -
      new Date(b.estimatedUtc ?? b.scheduledUtc).getTime(),
  );

  return { departures: out.slice(0, maxResults), stopName };
}

// ---- Scenario mutations ----------------------------------------------------

function applyScenario(departures: Departure[], scenario: MockScenario): Departure[] {
  switch (scenario) {
    case "empty":
      return [];
    case "sparse":
      // A stop with barely any service: tests short cards and empty columns.
      return departures.filter((_, i) => i % 3 === 0);
    case "cancel":
      // The one you were about to catch disappears between refreshes.
      return departures.slice(1);
    case "noestimates":
      return departures.map((d) => ({ ...d, estimatedUtc: null }));
    case "delay":
      return departures.map((d, i) => {
        const lateMs = (3 + (i % 4) * 2) * 60_000;
        return {
          ...d,
          estimatedUtc: new Date(new Date(d.scheduledUtc).getTime() + lateMs).toISOString(),
        };
      });
    default:
      return departures;
  }
}

// ---- Entry point -----------------------------------------------------------

export async function mockDepartures(
  db: D1Database,
  stopId: number,
  routeType: number,
  maxResults: number,
  scenario: MockScenario,
): Promise<{ departures: Departure[]; stopName: string; error?: string }> {
  if (scenario === "error") {
    return { departures: [], stopName: "", error: "PTV returned HTTP 503 (mock)" };
  }

  const now = Date.now();
  const fixture = FIXTURES[`${routeType}:${stopId}`];

  const built = fixture
    ? fromFixture(fixture, now, maxResults)
    : await generate(db, routeType, stopId, maxResults, now);

  return {
    departures: applyScenario(built.departures, scenario),
    stopName: built.stopName,
  };
}