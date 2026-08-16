/**
 * capture-fixtures.mjs - one-off fixture capture for mock mode
 *
 * Records real PTV departure patterns and writes them to src/fixtures.ts, so
 * `PTV_MOCK=1` can replay genuine route names, direction names, platforms and
 * irregular gaps without any credentials.
 *
 * This is optional. Mock mode already works without it: any stop with no
 * fixture gets a timetable generated from the routes in D1. Capture fixtures
 * when you want higher fidelity for the stops you look at most, or to pin down
 * an awkward case (a terminus, a City Loop split, a stop with one lonely bus).
 *
 * Departures are stored as offsets from the first departure rather than as
 * absolute times, so a fixture never expires and stays hand-editable.
 *
 * Usage:
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node capture-fixtures.mjs
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node capture-fixtures.mjs 0:1071 2:12345
 *
 * Arguments are routeType:stopId pairs (0 = metro train, 2 = metro bus) and
 * replace the default set below. To find a stop_id:
 *   npx wrangler d1 execute ptv-db --local \
 *     --command "SELECT stop_id, name FROM stations WHERE name LIKE '%Flinders%'"
 *
 * Requires Node 18+ (built-in fetch).
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

const DEV_ID = process.env.PTV_DEV_ID;
const API_KEY = process.env.PTV_API_KEY;
const BASE = "https://timetableapi.ptv.vic.gov.au";
const OUT_PATH = "src/fixtures.ts";

if (!DEV_ID || !API_KEY) {
  console.error("Set PTV_DEV_ID and PTV_API_KEY environment variables first.");
  process.exit(1);
}

// Must match the Worker, so a fixture holds as many departures as a real fetch.
const TRAIN_MAX_RESULTS = 16;
const BUS_MAX_RESULTS = 12;

// A spread worth having: an interchange, a terminus (single-list rendering), a
// Metro Tunnel station (split rendering), and the two default bus stops.
const DEFAULT_TARGETS = [
  { routeType: 0, stopId: 1072 }, // Footscray
  { routeType: 0, stopId: 1073 }, // Frankston - terminus
  { routeType: 0, stopId: 1233 }, // Parkville - tunnel_north
  { routeType: 2, stopId: 19740 },
  { routeType: 2, stopId: 20796 },
];

// ---- PTV request signing (HMAC-SHA1, uppercase hex) ------------------------
function signUrl(pathWithQuery) {
  const withDevId =
    pathWithQuery + (pathWithQuery.includes("?") ? "&" : "?") + "devid=" + DEV_ID;
  const signature = crypto
    .createHmac("sha1", API_KEY)
    .update(withDevId)
    .digest("hex")
    .toUpperCase();
  return `${BASE}${withDevId}&signature=${signature}`;
}

async function getJson(path) {
  const res = await fetch(signUrl(path));
  if (!res.ok) {
    throw new Error(`PTV ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

// ---- Arguments -------------------------------------------------------------
function parseTargets(argv) {
  const out = [];
  for (const arg of argv) {
    const [rt, id] = arg.split(":");
    const routeType = Number(rt);
    const stopId = Number(id);
    if (![0, 2].includes(routeType) || !Number.isInteger(stopId) || stopId <= 0) {
      console.error(`Skipping "${arg}" - expected routeType:stopId, e.g. 0:1072`);
      continue;
    }
    out.push({ routeType, stopId });
  }
  return out;
}

// ---- Capture ---------------------------------------------------------------
async function capture({ routeType, stopId }) {
  const maxResults = routeType === 0 ? TRAIN_MAX_RESULTS : BUS_MAX_RESULTS;
  const data = await getJson(
    `/v3/departures/route_type/${routeType}/stop/${stopId}` +
      `?max_results=${maxResults}&expand=stop&expand=route&expand=direction`,
  );

  const raw = (data.departures ?? [])
    .map((dep) => {
      const route = data.routes?.[dep.route_id];
      const direction = data.directions?.[dep.direction_id];
      const scheduled = Date.parse(dep.scheduled_departure_utc);
      if (!Number.isFinite(scheduled)) return null;
      const estimated = dep.estimated_departure_utc
        ? Date.parse(dep.estimated_departure_utc)
        : null;
      return {
        route: route?.route_number || route?.route_name || "?",
        routeId: Number(dep.route_id ?? -1),
        destination: direction?.direction_name ?? "?",
        platform: dep.platform_number ?? null,
        scheduled,
        estimateDeltaSeconds:
          estimated === null ? null : Math.round((estimated - scheduled) / 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.scheduled - b.scheduled);

  if (raw.length === 0) {
    console.warn(`  no departures returned for ${routeType}:${stopId} - skipped`);
    return null;
  }

  // Store offsets from the first departure, so the capture is time-independent.
  const first = raw[0].scheduled;
  return {
    key: `${routeType}:${stopId}`,
    stop: {
      stopName: data.stops?.[stopId]?.stop_name ?? `Stop ${stopId}`,
      capturedUtc: new Date().toISOString(),
      departures: raw.map((d) => ({
        route: d.route,
        routeId: d.routeId,
        destination: d.destination,
        platform: d.platform,
        offsetSeconds: Math.round((d.scheduled - first) / 1000),
        estimateDeltaSeconds: d.estimateDeltaSeconds,
      })),
    },
  };
}

// ---- File generation -------------------------------------------------------
const HEADER = `/**
 * Captured PTV departure patterns, replayed by src/mock.ts.
 *
 * This file is GENERATED by capture-fixtures.mjs. An empty FIXTURES object is
 * perfectly usable - mock mode falls back to a timetable generated from the
 * routes in D1 for any stop with no fixture here.
 *
 * Departures are stored as offsets from the first departure in the capture
 * rather than as absolute timestamps, so a fixture never goes out of date and
 * can be hand-edited to construct an awkward case.
 */

export interface FixtureDeparture {
  route: string;
  routeId: number;
  destination: string;
  platform: string | null;
  /** Seconds after the first departure in this capture. */
  offsetSeconds: number;
  /** estimated - scheduled, in seconds. null means no live estimate. */
  estimateDeltaSeconds: number | null;
}

export interface FixtureStop {
  stopName: string;
  capturedUtc: string;
  departures: FixtureDeparture[];
}

/** Keyed "routeType:stopId", e.g. "0:1072" or "2:19740". */
export const FIXTURES: Record<string, FixtureStop> = `;

async function main() {
  const targets = process.argv.length > 2 ? parseTargets(process.argv.slice(2)) : DEFAULT_TARGETS;
  if (targets.length === 0) {
    console.error("No valid targets. Pass pairs like 0:1072 2:19740.");
    process.exit(1);
  }

  console.log(`Capturing ${targets.length} stop(s)...`);
  const fixtures = {};

  for (const target of targets) {
    process.stdout.write(`  ${target.routeType}:${target.stopId} ... `);
    try {
      const result = await capture(target);
      if (result) {
        fixtures[result.key] = result.stop;
        console.log(`${result.stop.departures.length} departures (${result.stop.stopName})`);
      }
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  const body = JSON.stringify(fixtures, null, 2);
  writeFileSync(OUT_PATH, `${HEADER}${body};\n`, "utf8");

  const count = Object.keys(fixtures).length;
  console.log(`\nWrote ${count} fixture(s) to ${OUT_PATH}`);
  if (count === 0) {
    console.log("Nothing captured - mock mode will use generated timetables for every stop.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});