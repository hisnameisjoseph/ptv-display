/**
 * PTV Departures Board - Cloudflare Worker
 *
 * Endpoints:
 *   GET /api/board?stops=<routeType>:<stopId>,...
 *                                     -> departures for an ordered list of up
 *                                        to 8 stops. routeType is the PTV
 *                                        route_type (0 = metro train,
 *                                        2 = metro bus).
 *   GET /api/board?station=&bus1=&bus2=
 *                                     -> legacy shape, kept for one release so
 *                                        an already-open page survives a
 *                                        deploy. Emits the legacy stop keys
 *                                        ("train", "bus-1", "bus-2").
 *   GET /api/search?q=<term>          -> unified picker search across train
 *                                        stations and metro bus stops, with
 *                                        the routes serving each stop.
 *   GET /api/stations                 -> picker-ready list of all metro
 *                                        stations, with flinders_street and
 *                                        melbourne_central pairs merged into
 *                                        a single entry each.
 *   GET /api/stops/search?q=<term>    -> up to 20 metro bus stops matching
 *                                        the term as a subsequence, ranked
 *                                        prefix > substring > subsequence.
 *   (static dashboard is served from /public via the assets binding)
 *
 * Caching: departures are cached per stop, never per board. A board is just a
 * composition of independently cached stops, so two people watching different
 * card layouts that happen to share a stop share one upstream call. Total PTV
 * load is therefore proportional to the number of distinct stops being
 * watched, not to viewers multiplied by cards.
 *
 * Secrets (set with `wrangler secret put`):
 *   PTV_DEV_ID   - your numeric developer ID
 *   PTV_API_KEY  - your signing key (UUID-looking string)
 */
import { mockDepartures, parseScenario } from "./mock";

export interface Env {
  PTV_DEV_ID: string;
  PTV_API_KEY: string;
  ASSETS: Fetcher;
  DB: D1Database;
  /** Set in .dev.vars to answer departures locally. Unset in production. */
  PTV_MOCK?: string;
}

const PTV_BASE = "https://timetableapi.ptv.vic.gov.au";

// Per-stop cache windows, in seconds.
//
// Entries are *stored* for STOP_STALE_SECONDS but only considered *fresh* for
// STOP_FRESH_SECONDS. The gap is what makes stale-while-revalidate possible:
// past the freshness window we still have a usable copy to hand back
// immediately while a refresh runs behind the response, so a cache miss never
// makes the viewer wait on PTV. Freshness is judged from `fetchedUtc` in the
// body rather than from the stored Cache-Control header.
const STOP_FRESH_SECONDS = 45;
const STOP_STALE_SECONDS = 300;
// A failed fetch is cached briefly so a broken stop cannot hammer PTV on every
// request, but never long enough to keep showing a stale error.
const STOP_ERROR_FRESH_SECONDS = 10;

const TRAIN_MAX_RESULTS = 16; // per stop, per route+direction (PTV semantics)
const BUS_MAX_RESULTS = 12;   // was 5; a full-height bus card can show ~11 rows

// Hard ceiling on cards per board. Each stop is one PTV call on a cold cache,
// so this bounds the worst-case fan-out of a single request.
const MAX_STOPS = 8;

const ROUTE_TYPE_TRAIN = 0;
const ROUTE_TYPE_BUS = 2;
const ALLOWED_ROUTE_TYPES = new Set<number>([ROUTE_TYPE_TRAIN, ROUTE_TYPE_BUS]);

// Fallbacks for the legacy param shape.
const DEFAULT_STATION_STOP_ID = 1072; // Footscray
const DEFAULT_BUS_STOP_IDS = [19740, 20796];

// station_types whose stop_ids are physically paired and should have their
// departures merged into a single board (see schema.sql).
const MERGE_TYPES = new Set(["flinders_street", "melbourne_central"]);

// Stop search tuning. Must match MIN_SEARCH_CHARS in the frontend.
const MIN_SEARCH_CHARS = 3;
const SEARCH_MAX_RESULTS = 20;

// ---- PTV request signing (HMAC-SHA1, uppercase hex) -----------------------
async function signedUrl(pathWithQuery: string, env: Env): Promise<string> {
  const withDevId =
    pathWithQuery + (pathWithQuery.includes("?") ? "&" : "?") + "devid=" + env.PTV_DEV_ID;

  const keyData = new TextEncoder().encode(env.PTV_API_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(withDevId),
  );
  const signature = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return `${PTV_BASE}${withDevId}&signature=${signature}`;
}

// ---- Types for the slim board payload -------------------------------------
export interface Departure {
  route: string;    // e.g. "Werribee" line or bus number "82"
  routeId: number;  // PTV route_id; the client filters on this, not the label
  destination: string; // direction name
  platform: string | null;
  scheduledUtc: string;
  estimatedUtc: string | null; // null = timetable only
}

// What gets stored in the per-stop cache.
interface StopFetch {
  ok: boolean;
  fetchedUtc: string;
  stopName: string;
  departures: Departure[];
  error?: string;
}

interface StopBoard {
  key: string;          // "0:1072" for the stops= shape; legacy keys otherwise
  mode: "train" | "bus";
  routeType: number;
  stopId: number;
  label: string;
  stationType?: string; // train boards only; drives frontend split logic
  stopName: string;     // as reported by PTV, for sanity checking
  fetchedUtc: string;   // oldest upstream fetch behind this board
  departures: Departure[];
  error?: string;
}

interface StopRequest {
  key: string;
  routeType: number;
  stopId: number;
}

interface StationRow {
  stop_id: number;
  name: string;
  station_type: string;
}

interface RouteRow {
  stop_id: number;
  route_id: number;
  name: string;
  number: string | null;
}

interface SearchResult {
  mode: "train" | "bus";
  routeType: number;
  stopId: number;
  label: string;
  suburb: string | null;
  stationType?: string;
  routes: { id: number; label: string }[];
}

function byBestTime(a: Departure, b: Departure): number {
  const ta = new Date(a.estimatedUtc ?? a.scheduledUtc).getTime();
  const tb = new Date(b.estimatedUtc ?? b.scheduledUtc).getTime();
  return ta - tb;
}

function parseStopId(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function secondsSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 1000;
}

// ---- Request parsing -------------------------------------------------------

// "0:1072,2:19740" -> ordered, deduplicated, capped stop list. Malformed or
// unsupported entries are skipped rather than failing the whole board: a
// display should degrade, not go blank.
function parseStopsParam(raw: string): StopRequest[] {
  const out: StopRequest[] = [];
  const seen = new Set<string>();

  for (const chunk of raw.split(",")) {
    const piece = chunk.trim();
    if (!piece) continue;

    const sep = piece.indexOf(":");
    if (sep < 0) continue;

    const routeType = Number(piece.slice(0, sep));
    const stopId = Number(piece.slice(sep + 1));
    if (!ALLOWED_ROUTE_TYPES.has(routeType)) continue;
    if (!Number.isInteger(stopId) || stopId <= 0) continue;

    const key = `${routeType}:${stopId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ key, routeType, stopId });
    if (out.length >= MAX_STOPS) break;
  }

  return out;
}

// Legacy shape. The keys matter: the pre-cards frontend keys its CSS grid
// areas and its train/bus branching off exactly these strings.
function legacyStops(url: URL): StopRequest[] {
  const station = parseStopId(url.searchParams.get("station")) ?? DEFAULT_STATION_STOP_ID;
  const bus1 = parseStopId(url.searchParams.get("bus1")) ?? DEFAULT_BUS_STOP_IDS[0];
  const bus2 = parseStopId(url.searchParams.get("bus2")) ?? DEFAULT_BUS_STOP_IDS[1];
  return [
    { key: "train", routeType: ROUTE_TYPE_TRAIN, stopId: station },
    { key: "bus-1", routeType: ROUTE_TYPE_BUS, stopId: bus1 },
    { key: "bus-2", routeType: ROUTE_TYPE_BUS, stopId: bus2 },
  ];
}

// ---- Fetch departures for one physical stop -------------------------------
async function fetchDepartures(
  stopId: number,
  routeType: number,
  maxResults: number,
  env: Env,
): Promise<{ departures: Departure[]; stopName: string; error?: string }> {
  // Mock mode intercepts here, at the single point that talks to PTV, so
  // everything downstream runs against fake departures unchanged.
  const scenario = parseScenario(env.PTV_MOCK);
  if (scenario) return mockDepartures(env.DB, stopId, routeType, maxResults, scenario);

  const path =
    `/v3/departures/route_type/${routeType}/stop/${stopId}` +
    `?max_results=${maxResults}&expand=stop&expand=route&expand=direction`;

  try {
    const res = await fetch(await signedUrl(path, env));
    if (!res.ok) {
      return { departures: [], stopName: "", error: `PTV returned HTTP ${res.status}` };
    }
    const data: any = await res.json();

    const departures: Departure[] = (data.departures ?? []).map((dep: any) => {
      const route = data.routes?.[dep.route_id];
      const direction = data.directions?.[dep.direction_id];
      return {
        route: route?.route_number || route?.route_name || "?",
        routeId: Number(dep.route_id ?? -1),
        destination: direction?.direction_name ?? "?",
        platform: dep.platform_number ?? null,
        scheduledUtc: dep.scheduled_departure_utc,
        estimatedUtc: dep.estimated_departure_utc ?? null,
      };
    });

    return {
      departures,
      stopName: data.stops?.[stopId]?.stop_name ?? "unknown",
    };
  } catch (err) {
    return {
      departures: [],
      stopName: "",
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

// ---- Per-stop cache --------------------------------------------------------

// A synthetic same-origin URL, used only as a cache key. Nothing ever routes
// here; it exists so each stop gets its own entry in the edge cache.
function stopCacheKey(origin: string, routeType: number, stopId: number): Request {
  return new Request(`${origin}/__stop/${routeType}/${stopId}`);
}

async function fetchAndStore(
  cacheKey: Request,
  routeType: number,
  stopId: number,
  maxResults: number,
  env: Env,
): Promise<StopFetch> {
  const raw = await fetchDepartures(stopId, routeType, maxResults, env);
  const payload: StopFetch = {
    ok: !raw.error,
    fetchedUtc: new Date().toISOString(),
    stopName: raw.stopName,
    departures: raw.departures,
    ...(raw.error ? { error: raw.error } : {}),
  };

  const stored = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${STOP_STALE_SECONDS}`,
    },
  });

  try {
    await caches.default.put(cacheKey, stored);
  } catch {
    // Cache writes are best-effort; a failure just means the next request
    // fetches again.
  }

  return payload;
}

async function loadStop(
  origin: string,
  routeType: number,
  stopId: number,
  maxResults: number,
  env: Env,
  ctx: ExecutionContext,
): Promise<StopFetch> {
  const cacheKey = stopCacheKey(origin, routeType, stopId);

  let cached: StopFetch | null = null;
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) cached = (await hit.json()) as StopFetch;
  } catch {
    cached = null;
  }

  if (cached) {
    const age = secondsSince(cached.fetchedUtc);

    if (cached.ok) {
      if (age < STOP_FRESH_SECONDS) return cached;
      // Stale but usable: hand it back now, refresh behind the response.
      // Concurrent requests may each kick off a refresh; the write is
      // idempotent and the volume is trivial at this scale.
      ctx.waitUntil(
        fetchAndStore(cacheKey, routeType, stopId, maxResults, env).then(() => undefined),
      );
      return cached;
    }

    // A cached failure is worth honouring only long enough to avoid hammering
    // PTV. Never serve a stale error beyond that.
    if (age < STOP_ERROR_FRESH_SECONDS) return cached;
  }

  return fetchAndStore(cacheKey, routeType, stopId, maxResults, env);
}

// ---- Reference data lookups (batched, so card count costs no extra queries) -

async function loadStationRows(
  stopIds: number[],
  env: Env,
): Promise<Map<number, StationRow>> {
  if (stopIds.length === 0) return new Map();
  const unique = [...new Set(stopIds)];
  const placeholders = unique.map(() => "?").join(", ");
  try {
    const { results } = await env.DB.prepare(
      `SELECT stop_id, name, station_type FROM stations WHERE stop_id IN (${placeholders})`,
    ).bind(...unique).all<StationRow>();
    return new Map(results.map((r) => [r.stop_id, r]));
  } catch {
    return new Map();
  }
}

// All physical stops belonging to each merged station type, e.g. Flinders
// Street plus Town Hall.
async function loadMergeGroups(
  types: string[],
  env: Env,
): Promise<Map<string, StationRow[]>> {
  if (types.length === 0) return new Map();
  const placeholders = types.map(() => "?").join(", ");
  const grouped = new Map<string, StationRow[]>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT stop_id, name, station_type FROM stations
        WHERE station_type IN (${placeholders})
        ORDER BY stop_id`,
    ).bind(...types).all<StationRow>();
    for (const row of results) {
      const list = grouped.get(row.station_type) ?? [];
      list.push(row);
      grouped.set(row.station_type, list);
    }
  } catch {
    /* fall through to an empty map; boards render unmerged */
  }
  return grouped;
}

// One D1 round trip for every bus label on the board, rather than one per stop.
async function busLabels(stopIds: number[], env: Env): Promise<Map<number, string>> {
  if (stopIds.length === 0) return new Map();
  const unique = [...new Set(stopIds)];
  const placeholders = unique.map(() => "?").join(", ");
  try {
    const { results } = await env.DB.prepare(
      `SELECT stop_id, name FROM bus_stops WHERE stop_id IN (${placeholders})`,
    ).bind(...unique).all<{ stop_id: number; name: string }>();
    return new Map(results.map((r) => [r.stop_id, r.name]));
  } catch {
    // bus_stops may not exist yet (import not run). Fall back to PTV names.
    return new Map();
  }
}

// ---- Board builders --------------------------------------------------------

function oldestFetch(parts: StopFetch[]): string {
  return parts.reduce(
    (acc, p) => (p.fetchedUtc < acc ? p.fetchedUtc : acc),
    parts[0].fetchedUtc,
  );
}

async function buildTrainBoard(
  req: StopRequest,
  stationRow: StationRow | undefined,
  mergeGroups: Map<string, StationRow[]>,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<StopBoard> {
  if (!stationRow) {
    return {
      key: req.key,
      mode: "train",
      routeType: ROUTE_TYPE_TRAIN,
      stopId: req.stopId,
      label: "Unknown station",
      stopName: "",
      fetchedUtc: new Date().toISOString(),
      departures: [],
      error: `No station found for stop_id ${req.stopId}`,
    };
  }

  let stopIds = [stationRow.stop_id];
  let label = stationRow.name;

  if (MERGE_TYPES.has(stationRow.station_type)) {
    const group = mergeGroups.get(stationRow.station_type);
    if (group && group.length > 0) {
      stopIds = group.map((r) => r.stop_id);
      label = group.map((r) => r.name).join(" / ");
    }
  }

  // Each physical stop is cached separately, so Flinders Street and Town Hall
  // are shared with anyone else watching either one.
  const parts = await Promise.all(
    stopIds.map((id) => loadStop(origin, ROUTE_TYPE_TRAIN, id, TRAIN_MAX_RESULTS, env, ctx)),
  );

  const departures = parts.flatMap((p) => p.departures).sort(byBestTime);
  const allFailed = parts.every((p) => !p.ok);

  return {
    key: req.key,
    mode: "train",
    routeType: ROUTE_TYPE_TRAIN,
    stopId: req.stopId,
    label,
    stationType: stationRow.station_type,
    stopName: parts.map((p) => p.stopName).filter(Boolean).join(" + "),
    fetchedUtc: oldestFetch(parts),
    departures,
    ...(allFailed ? { error: parts[0].error ?? "PTV request failed" } : {}),
  };
}

async function buildBusBoard(
  req: StopRequest,
  labels: Map<number, string>,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<StopBoard> {
  const part = await loadStop(origin, ROUTE_TYPE_BUS, req.stopId, BUS_MAX_RESULTS, env, ctx);

  return {
    key: req.key,
    mode: "bus",
    routeType: ROUTE_TYPE_BUS,
    stopId: req.stopId,
    // Prefer our own imported name; fall back to whatever PTV reported.
    label: labels.get(req.stopId) ?? part.stopName ?? `Stop ${req.stopId}`,
    stopName: part.stopName,
    fetchedUtc: part.fetchedUtc,
    departures: [...part.departures].sort(byBestTime),
    ...(part.error ? { error: part.error } : {}),
  };
}

// ---- Search ----------------------------------------------------------------
// Mirrors the frontend's subsequenceMatch: every character of the query must
// appear in order within the name. In SQL that is LIKE '%m%c%'. Each
// character is escaped individually before the wildcards are interleaved, so
// a literal % or _ typed by the user cannot widen the match.
function buildLikePatterns(compact: string): {
  subsequence: string;
  prefix: string;
  contains: string;
} {
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
  const chars = [...compact].map(esc);
  return {
    subsequence: "%" + chars.join("%") + "%",
    prefix: esc(compact) + "%",
    contains: "%" + esc(compact) + "%",
  };
}

// Ranking tier, computed on space-stripped names so a two-word query still
// reaches the prefix tier ("moreland st" -> "morelandst" vs "MorelandSt/...").
function rankOf(compact: string, name: string): number {
  const n = name.toLowerCase().replace(/\s+/g, "");
  const q = compact.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  return 2;
}

async function routesForStops(
  table: "station_routes" | "bus_stop_routes",
  stopIds: number[],
  preferNumber: boolean,
  env: Env,
): Promise<Map<number, { id: number; label: string }[]>> {
  const out = new Map<number, { id: number; label: string }[]>();
  if (stopIds.length === 0) return out;

  const unique = [...new Set(stopIds)];
  const placeholders = unique.map(() => "?").join(", ");
  try {
    const { results } = await env.DB.prepare(
      `SELECT sr.stop_id, r.route_id, r.name, r.number
         FROM ${table} sr
         JOIN routes r ON r.route_id = sr.route_id
        WHERE sr.stop_id IN (${placeholders})`,
    ).bind(...unique).all<RouteRow>();

    for (const row of results) {
      // Match how a departure renders its route: number first for buses,
      // name for trains.
      const label = preferNumber ? (row.number || row.name) : (row.name || row.number || "?");
      const list = out.get(row.stop_id) ?? [];
      if (!list.some((r) => r.id === row.route_id)) {
        list.push({ id: row.route_id, label });
      }
      out.set(row.stop_id, list);
    }
  } catch {
    /* routes are decoration on a search result; an empty map is fine */
  }
  return out;
}

function sortRouteLabels(routes: { id: number; label: string }[]): { id: number; label: string }[] {
  return [...routes].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

async function unifiedSearch(compact: string, env: Env): Promise<SearchResult[]> {
  const { subsequence, prefix, contains } = buildLikePatterns(compact);

  const [stationRes, busRes] = await Promise.all([
    env.DB.prepare(
      `SELECT stop_id, name, suburb, station_type
         FROM stations
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY CASE
                   WHEN name LIKE ? ESCAPE '\\' THEN 0
                   WHEN name LIKE ? ESCAPE '\\' THEN 1
                   ELSE 2
                 END,
                 name
        LIMIT ${SEARCH_MAX_RESULTS}`,
    )
      .bind(subsequence, prefix, contains)
      .all<{ stop_id: number; name: string; suburb: string | null; station_type: string }>(),

    env.DB.prepare(
      `SELECT stop_id, name, suburb
         FROM bus_stops
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY CASE
                   WHEN name LIKE ? ESCAPE '\\' THEN 0
                   WHEN name LIKE ? ESCAPE '\\' THEN 1
                   ELSE 2
                 END,
                 name
        LIMIT ${SEARCH_MAX_RESULTS}`,
    )
      .bind(subsequence, prefix, contains)
      .all<{ stop_id: number; name: string; suburb: string | null }>(),
  ]);

  // Collapse paired stations (Flinders St / Town Hall) into one entry, the
  // same way /api/stations does, so searching either name offers the merged
  // board rather than two half-boards.
  const mergeTypesHit = [
    ...new Set(
      stationRes.results
        .map((r) => r.station_type)
        .filter((t) => MERGE_TYPES.has(t)),
    ),
  ];
  const mergeGroups = await loadMergeGroups(mergeTypesHit, env);

  const stationEntries: { row: typeof stationRes.results[number]; memberIds: number[] }[] = [];
  const seenStation = new Set<number>();

  for (const row of stationRes.results) {
    if (MERGE_TYPES.has(row.station_type)) {
      const group = mergeGroups.get(row.station_type);
      if (group && group.length > 0) {
        const repId = group[0].stop_id;
        if (seenStation.has(repId)) continue;
        seenStation.add(repId);
        stationEntries.push({
          row: {
            ...row,
            stop_id: repId,
            name: group.map((g) => g.name).join(" / "),
          },
          memberIds: group.map((g) => g.stop_id),
        });
        continue;
      }
    }
    if (seenStation.has(row.stop_id)) continue;
    seenStation.add(row.stop_id);
    stationEntries.push({ row, memberIds: [row.stop_id] });
  }

  const [stationRoutes, busRoutes] = await Promise.all([
    routesForStops(
      "station_routes",
      stationEntries.flatMap((e) => e.memberIds),
      false,
      env,
    ),
    routesForStops(
      "bus_stop_routes",
      busRes.results.map((r) => r.stop_id),
      true,
      env,
    ),
  ]);

  const merged: (SearchResult & { rank: number })[] = [
    ...stationEntries.map(({ row, memberIds }) => {
      // A merged station's routes are the union across its physical stops.
      const routes: { id: number; label: string }[] = [];
      for (const id of memberIds) {
        for (const r of stationRoutes.get(id) ?? []) {
          if (!routes.some((x) => x.id === r.id)) routes.push(r);
        }
      }
      return {
        mode: "train" as const,
        routeType: ROUTE_TYPE_TRAIN,
        stopId: row.stop_id,
        label: row.name,
        suburb: row.suburb,
        stationType: row.station_type,
        routes: sortRouteLabels(routes),
        rank: rankOf(compact, row.name),
      };
    }),
    ...busRes.results.map((row) => ({
      mode: "bus" as const,
      routeType: ROUTE_TYPE_BUS,
      stopId: row.stop_id,
      label: row.name,
      suburb: row.suburb,
      routes: sortRouteLabels(busRoutes.get(row.stop_id) ?? []),
      rank: rankOf(compact, row.name),
    })),
  ];

  // Rank tier first, then trains ahead of buses within a tier (a station is
  // usually the intent when a query matches both), then alphabetically.
  merged.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.mode !== b.mode) return a.mode === "train" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return merged.slice(0, SEARCH_MAX_RESULTS).map(({ rank, ...rest }) => rest);
}

// ---- Worker entry ---------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // future Pi / e-ink clients welcome
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---- GET /api/stations -> picker-ready list of all metro stations -------
    if (url.pathname === "/api/stations") {
      const { results } = await env.DB.prepare(
        `SELECT stop_id, name, station_type FROM stations ORDER BY name`,
      ).all<StationRow>();

      const grouped: Record<string, StationRow[]> = {};
      const singles: StationRow[] = [];

      for (const row of results) {
        if (MERGE_TYPES.has(row.station_type)) {
          (grouped[row.station_type] ??= []).push(row);
        } else {
          singles.push(row);
        }
      }

      const picker = [
        ...singles.map((r) => ({
          key: r.stop_id,
          label: r.name,
          stationType: r.station_type,
        })),
        ...Object.entries(grouped).map(([type, rows]) => {
          const sorted = [...rows].sort((a, b) => a.stop_id - b.stop_id);
          return {
            key: sorted[0].stop_id,
            label: sorted.map((r) => r.name).join(" / "),
            stationType: type,
          };
        }),
      ].sort((a, b) => a.label.localeCompare(b.label));

      return json(picker);
    }

    // ---- GET /api/search -> unified station + bus stop picker ---------------
    if (url.pathname === "/api/search") {
      const compact = (url.searchParams.get("q") ?? "").replace(/\s+/g, "");
      if (compact.length < MIN_SEARCH_CHARS) return json([]);
      return json(await unifiedSearch(compact, env));
    }

    // ---- GET /api/stops/search -> metro bus stops matching a term -----------
    if (url.pathname === "/api/stops/search") {
      const compact = (url.searchParams.get("q") ?? "").replace(/\s+/g, "");
      if (compact.length < MIN_SEARCH_CHARS) return json([]);

      const { subsequence, prefix, contains } = buildLikePatterns(compact);

      // Ranking matters: with 3 characters, a bare subsequence match returns
      // a lot of noise. Prefix matches first, then substring, then the rest.
      const { results } = await env.DB.prepare(
        `SELECT s.stop_id,
                s.name,
                s.suburb,
                (SELECT group_concat(DISTINCT r.number)
                   FROM bus_stop_routes bsr
                   JOIN routes r ON r.route_id = bsr.route_id
                  WHERE bsr.stop_id = s.stop_id
                    AND r.number IS NOT NULL
                    AND r.number != '') AS route_numbers
           FROM bus_stops s
          WHERE s.name LIKE ? ESCAPE '\\'
          ORDER BY CASE
                     WHEN s.name LIKE ? ESCAPE '\\' THEN 0
                     WHEN s.name LIKE ? ESCAPE '\\' THEN 1
                     ELSE 2
                   END,
                   s.name
          LIMIT ${SEARCH_MAX_RESULTS}`,
      )
        .bind(subsequence, prefix, contains)
        .all<{ stop_id: number; name: string; suburb: string | null; route_numbers: string | null }>();

      // Strip PTV's route objects down to just the numbers the picker shows.
      const slim = results.map((r) => ({
        stopId: r.stop_id,
        label: r.name,
        suburb: r.suburb,
        routes: (r.route_numbers ?? "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      }));

      return json(slim);
    }

    // ---- GET /api/board -> departures for an ordered list of stops ----------
    if (url.pathname === "/api/board") {
      const stopsParam = url.searchParams.get("stops");
      const legacy = stopsParam === null;
      const requested = legacy ? legacyStops(url) : parseStopsParam(stopsParam);

      if (requested.length === 0) {
        return json(
          { updatedUtc: new Date().toISOString(), staleAtUtc: null, stops: [] },
          { "Cache-Control": "no-store" },
        );
      }

      // Reference data first: two or three D1 round trips regardless of how
      // many cards the board carries.
      const trainIds = requested
        .filter((s) => s.routeType === ROUTE_TYPE_TRAIN)
        .map((s) => s.stopId);
      const busIds = requested
        .filter((s) => s.routeType === ROUTE_TYPE_BUS)
        .map((s) => s.stopId);

      const [stationRows, labels] = await Promise.all([
        loadStationRows(trainIds, env),
        busLabels(busIds, env),
      ]);

      const mergeTypesNeeded = [
        ...new Set(
          trainIds
            .map((id) => stationRows.get(id)?.station_type)
            .filter((t): t is string => typeof t === "string" && MERGE_TYPES.has(t)),
        ),
      ];
      const mergeGroups = await loadMergeGroups(mergeTypesNeeded, env);

      const stops = await Promise.all(
        requested.map((req) =>
          req.routeType === ROUTE_TYPE_TRAIN
            ? buildTrainBoard(req, stationRows.get(req.stopId), mergeGroups, url.origin, env, ctx)
            : buildBusBoard(req, labels, url.origin, env, ctx),
        ),
      );

      // When the oldest stop behind this board goes stale. The client uses it
      // to line its next poll up with the cache window instead of guessing.
      const oldest = stops.reduce(
        (acc, s) => (s.fetchedUtc < acc ? s.fetchedUtc : acc),
        stops[0].fetchedUtc,
      );
      const staleAtUtc = new Date(
        new Date(oldest).getTime() + STOP_FRESH_SECONDS * 1000,
      ).toISOString();

      const body: Record<string, unknown> = {
        updatedUtc: new Date().toISOString(),
        staleAtUtc,
        stops,
      };
      // The pre-cards frontend reads `station` off the payload; keep it for as
      // long as the legacy params are supported.
      if (legacy) body.station = requested[0].stopId;

      // The board itself is not cached: it is a cheap composition of per-stop
      // cache reads, and caching the combination is what this change moved
      // away from.
      return json(body, { "Cache-Control": "no-store" });
    }

    // Everything else: serve the static dashboard
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;