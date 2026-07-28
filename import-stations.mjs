/**
 * import-stations.mjs - Milestone 1 one-off importer
 *
 * Fetches every metro route's stops from the PTV API, deduplicates into a
 * station list, auto-classifies each station's type, and writes the reference
 * tables (routes, stations, station_routes) into D1.
 *
 * Prereqs:
 *   - schema.sql already applied to the D1 database (see its header).
 *   - wrangler installed and logged in; a d1 database named in wrangler.jsonc.
 *
 * Usage:
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node import-stations.mjs            # local D1
 *   PTV_DEV_ID=xxx PTV_API_KEY=xxx node import-stations.mjs --remote   # remote D1
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
const D1_NAME = "ptv-db"; // must match the database_name in wrangler.jsonc

if (!DEV_ID || !API_KEY) {
  console.error("Set PTV_DEV_ID and PTV_API_KEY environment variables first.");
  process.exit(1);
}

// Metro route_ids you provided (route_type 0). Names are filled from the API
// where available; this list is the seed set the importer loops over.
const METRO_ROUTE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 1482
];

// ---- Hand-labelled classification (wins over auto-detection) ---------------
// Metro Tunnel + underground loop stations aren't distinguishable from the
// API alone, and the CBD specials need explicit types.
const SPECIAL_TYPES = {
  // Flinders Street, Southern Cross, Melbourne Central (by stop_id)
  1071: "flinders_street",
  1181: "southern_cross",
  1120: "melbourne_central",
  1235: "flinders_street",   // Town Hall (paired with Flinders St)
  1234: "melbourne_central", // State Library (paired with Melbourne Central)
  // Underground City Loop
  1068: "loop",              // Flagstaff
  1155: "loop",              // Parliament
  // Metro Tunnel
  1236: "tunnel",            // Anzac
  1233: "tunnel",            // Parkville
  1232: "tunnel",            // Arden
  1002: "terminus",          // Alamein
  1018: "terminus",          // Belgrave
  1044: "terminus",          // Craigieburn
  1187: "terminus",          // Subury
  1045: "terminus",          // Cranbourne
  1070: "terminus",          // Flemington Racecourse
  1073: "terminus",          // Frankston
  1078: "terminus",          // Glen Waverly
  1100: "terminus",          // Hurtsbridge
  1115: "terminus",          // Lilydale
  1228: "terminus",          // Mernda
  1230: "terminus",          // East Pakenham
  1173: "terminus",          // Sandringham
  1185: "terminus",          // Stony Point
  1198: "terminus",          // Upfield
  1205: "terminus",          // Werribee
  1211: "terminus",          // Williamstown
};

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

// ---- SQL escaping ----------------------------------------------------------
function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlNum(v) {
  return v === null || v === undefined || Number.isNaN(v) ? "NULL" : String(v);
}

// ---- Main ------------------------------------------------------------------
async function main() {
  console.log(`Importing metro station data (${REMOTE ? "remote" : "local"} D1)...`);

  const routes = new Map();        // route_id -> { name, number, colour }
  const stations = new Map();      // stop_id -> { name, lat, lng, suburb }
  const stationRoutes = new Set(); // "stopId:routeId"
  const routeCountByStop = new Map(); // stop_id -> number of routes (interchange)
  const terminusStops = new Set();    // stop_ids that are an endpoint somewhere

  for (const routeId of METRO_ROUTE_IDS) {
    // Route metadata (name/number). expand nothing; the route object suffices.
    let routeName = `Route ${routeId}`;
    let routeNumber = null;
    try {
      const routeData = await getJson(`/v3/routes/${routeId}`);
      routeName = routeData?.route?.route_name ?? routeName;
      routeNumber = routeData?.route?.route_number || null;
    } catch (err) {
      console.warn(`  ! route ${routeId} metadata failed: ${err.message}`);
    }
    routes.set(routeId, { name: routeName, number: routeNumber, colour: null });

    // Stops for this route, in sequence. stop_sequence lets us find termini.
    const stopsData = await getJson(
      `/v3/stops/route/${routeId}/route_type/0?direction_id=0`,
    );
    const stopList = stopsData?.stops ?? [];

    // Determine the min/max sequence to identify endpoints (termini).
    let minSeq = Infinity;
    let maxSeq = -Infinity;
    for (const s of stopList) {
      const seq = s.stop_sequence ?? 0;
      if (seq < minSeq) minSeq = seq;
      if (seq > maxSeq) maxSeq = seq;
    }

    for (const s of stopList) {
      const id = s.stop_id;
      if (!stations.has(id)) {
        stations.set(id, {
          name: s.stop_name?.trim() ?? `Stop ${id}`,
          lat: s.stop_latitude ?? null,
          lng: s.stop_longitude ?? null,
          suburb: s.stop_suburb ?? null,
        });
      }
      const key = `${id}:${routeId}`;
      if (!stationRoutes.has(key)) {
        stationRoutes.add(key);
        routeCountByStop.set(id, (routeCountByStop.get(id) ?? 0) + 1);
      }
      const seq = s.stop_sequence ?? 0;
    //   if (seq === minSeq || seq === maxSeq) terminusStops.add(id);
    }

    console.log(`  route ${routeId} (${routeName}): ${stopList.length} stops`);
  }

  // ---- Classify each station ----
  function classify(stopId) {
    if (SPECIAL_TYPES[stopId]) return SPECIAL_TYPES[stopId];
    const routeCount = routeCountByStop.get(stopId) ?? 0;
    if (routeCount >= 2) return "interchange";
    // if (terminusStops.has(stopId)) return "terminus";
    return "through";
  }

  // ---- Build the SQL ----
  const lines = [];
  lines.push("BEGIN TRANSACTION;");
  lines.push("DELETE FROM station_routes;");
  lines.push("DELETE FROM stations;");
  lines.push("DELETE FROM routes;");

  for (const [routeId, r] of routes) {
    lines.push(
      `INSERT INTO routes (route_id, route_type, name, number, colour) VALUES ` +
        `(${routeId}, 0, ${sqlStr(r.name)}, ${sqlStr(r.number)}, ${sqlStr(r.colour)});`,
    );
  }

  for (const [stopId, s] of stations) {
    const type = classify(stopId);
    const isTerminus = terminusStops.has(stopId) ? 1 : 0;
    lines.push(
      `INSERT INTO stations (stop_id, name, latitude, longitude, suburb, station_type, is_terminus) VALUES ` +
        `(${stopId}, ${sqlStr(s.name)}, ${sqlNum(s.lat)}, ${sqlNum(s.lng)}, ${sqlStr(s.suburb)}, ${sqlStr(type)}, ${isTerminus});`,
    );
  }

  for (const key of stationRoutes) {
    const [stopId, routeId] = key.split(":");
    lines.push(
      `INSERT INTO station_routes (stop_id, route_id) VALUES (${stopId}, ${routeId});`,
    );
  }

  lines.push("COMMIT;");

  const sql = lines.join("\n");
  const tmpFile = "._import_stations.generated.sql";
  writeFileSync(tmpFile, sql);

  console.log(
    `\nPrepared ${routes.size} routes, ${stations.size} stations, ${stationRoutes.size} station-route links.`,
  );

  // ---- Apply via wrangler ----
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

  // ---- Print a classification summary so you can eyeball it ----
  const byType = {};
  for (const stopId of stations.keys()) {
    const t = classify(stopId);
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log("\nStation type summary:");
  for (const [t, n] of Object.entries(byType).sort()) {
    console.log(`  ${t.padEnd(18)} ${n}`);
  }
}

main().catch((err) => {
  console.error("\nImport failed:", err.message);
  process.exit(1);
});