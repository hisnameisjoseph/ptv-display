/**
 * import-bus-stops.mjs - metro bus stop importer
 *
 * Fetches every metro bus route (route_type 2) and its stops from the PTV
 * API, deduplicates into a stop list, and writes bus_stops + bus_stop_routes
 * into D1. Bus routes go into the shared `routes` table with route_type 2.
 *
 * This is deliberately a separate script from import-stations.mjs so that
 * re-running one cannot clobber the other's data.
 *
 * Prereqs:
 *   - schema.sql and schema-bus.sql already applied (see their headers).
 *   - wrangler installed and logged in.
 *
 * Usage:
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node import-bus-stops.mjs
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node import-bus-stops.mjs --remote
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node import-bus-stops.mjs --limit=5
 *
 * --limit=N fetches only the first N routes. Use it for a quick smoke test
 * before committing to the full run, which takes a few minutes (~350 routes).
 *
 * Requires Node 18+ (built-in fetch) and wrangler on PATH.
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const DEV_ID = process.env.PTV_DEV_ID;
const API_KEY = process.env.PTV_API_KEY;
const BASE = "https://timetableapi.ptv.vic.gov.au";
const REMOTE = process.argv.includes("--remote");
const D1_NAME = "ptv-db"; // must match database_name in wrangler.jsonc

const ROUTE_TYPE_BUS = 2;
const INSERT_CHUNK = 500;  // rows per multi-row INSERT statement
const CALL_DELAY_MS = 100; // be polite to PTV between route calls

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const ROUTE_LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

if (!DEV_ID || !API_KEY) {
  console.error("Set PTV_DEV_ID and PTV_API_KEY environment variables first.");
  process.exit(1);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- SQL escaping ----------------------------------------------------------
function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlNum(v) {
  return v === null || v === undefined || Number.isNaN(v) ? "NULL" : String(v);
}

// Multi-row INSERTs keep the generated file small and fast to apply.
// 58k separate statements would take wrangler a very long time to chew through.
function pushBatchedInserts(lines, table, columns, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    lines.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n` +
        chunk.map((r) => "  (" + r.join(", ") + ")").join(",\n") +
        ";",
    );
  }
}

// ---- Main ------------------------------------------------------------------
async function main() {
  console.log(`Importing metro bus stops (${REMOTE ? "remote" : "local"} D1)...`);

  // 1. All metro bus routes in one call.
  const routesData = await getJson(`/v3/routes?route_types=${ROUTE_TYPE_BUS}`);
  let allRoutes = routesData?.routes ?? [];
  if (allRoutes.length === 0) {
    throw new Error("PTV returned no bus routes; aborting rather than wiping tables.");
  }
  if (Number.isFinite(ROUTE_LIMIT)) {
    allRoutes = allRoutes.slice(0, ROUTE_LIMIT);
    console.log(`  --limit active: using first ${allRoutes.length} routes only.`);
  }
  console.log(`  ${allRoutes.length} bus routes to walk.`);

  const routes = new Map();      // route_id -> { name, number }
  const stops = new Map();       // stop_id  -> { name, suburb, lat, lng }
  const stopRoutes = new Set();  // "stopId:routeId"
  const failedRoutes = [];

  // 2. Stops for each route. One call per route returns every stop on it.
  let done = 0;
  for (const r of allRoutes) {
    const routeId = r.route_id;
    routes.set(routeId, {
      name: r.route_name ?? `Route ${routeId}`,
      number: r.route_number || null,
    });

    try {
      const stopsData = await getJson(
        `/v3/stops/route/${routeId}/route_type/${ROUTE_TYPE_BUS}`,
      );
      for (const s of stopsData?.stops ?? []) {
        const id = s.stop_id;
        if (!stops.has(id)) {
          stops.set(id, {
            name: (s.stop_name ?? `Stop ${id}`).trim(),
            suburb: s.stop_suburb ?? null,
            lat: s.stop_latitude ?? null,
            lng: s.stop_longitude ?? null,
          });
        }
        stopRoutes.add(`${id}:${routeId}`);
      }
    } catch (err) {
      failedRoutes.push(routeId);
      console.warn(`  ! route ${routeId} stops failed: ${err.message}`);
    }

    done++;
    if (done % 25 === 0 || done === allRoutes.length) {
      console.log(
        `  ${done}/${allRoutes.length} routes - ${stops.size} stops so far`,
      );
    }
    await sleep(CALL_DELAY_MS);
  }

  if (stops.size === 0) {
    throw new Error("No stops collected; aborting rather than wiping tables.");
  }

  // 3. Build the SQL.
  const lines = [];
  lines.push("DELETE FROM bus_stop_routes;");
  lines.push("DELETE FROM bus_stops;");
  // Only clear BUS routes. Train routes (route_type 0) belong to
  // import-stations.mjs and must survive this import untouched.
  lines.push(`DELETE FROM routes WHERE route_type = ${ROUTE_TYPE_BUS};`);

  pushBatchedInserts(
    lines,
    "routes",
    ["route_id", "route_type", "name", "number", "colour"],
    [...routes].map(([id, r]) => [
      id,
      ROUTE_TYPE_BUS,
      sqlStr(r.name),
      sqlStr(r.number),
      "NULL",
    ]),
  );

  pushBatchedInserts(
    lines,
    "bus_stops",
    ["stop_id", "name", "suburb", "latitude", "longitude"],
    [...stops].map(([id, s]) => [
      id,
      sqlStr(s.name),
      sqlStr(s.suburb),
      sqlNum(s.lat),
      sqlNum(s.lng),
    ]),
  );

  pushBatchedInserts(
    lines,
    "bus_stop_routes",
    ["stop_id", "route_id"],
    [...stopRoutes].map((key) => key.split(":")),
  );

  const tmpFile = "._import_bus_stops.generated.sql";
  writeFileSync(tmpFile, lines.join("\n"));

  console.log(
    `\nPrepared ${routes.size} routes, ${stops.size} stops, ${stopRoutes.size} stop-route links.`,
  );
  if (failedRoutes.length > 0) {
    console.warn(`${failedRoutes.length} route(s) failed: ${failedRoutes.join(", ")}`);
  }

  // 4. Apply via wrangler.
  const args = [
    "d1", "execute", D1_NAME,
    REMOTE ? "--remote" : "--local",
    `--file=${tmpFile}`,
  ];
  try {
    console.log(`Running: npx wrangler ${args.join(" ")}`);
    execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
    console.log("\nImport complete.");
  } finally {
    unlinkSync(tmpFile);
  }
}

main().catch((err) => {
  console.error("\nImport failed:", err.message);
  process.exit(1);
});