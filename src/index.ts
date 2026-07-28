/**
 * PTV Departures Board - Cloudflare Worker
 *
 * Endpoints:
 *   GET /api/board?station=<stop_id>  -> departures for the chosen train
 *                                        station (by stop_id) plus the fixed
 *                                        Footscray bus stops. Defaults to
 *                                        Footscray (1072) if missing/invalid.
 *   GET /api/stations                 -> picker-ready list of all metro
 *                                        stations, with flinders_street and
 *                                        melbourne_central pairs merged into
 *                                        a single entry each.
 *   (static dashboard is served from /public via the assets binding)
 *
 * Secrets (set with `wrangler secret put`):
 *   PTV_DEV_ID   - your numeric developer ID
 *   PTV_API_KEY  - your signing key (UUID-looking string)
 */

export interface Env {
  PTV_DEV_ID: string;
  PTV_API_KEY: string;
  ASSETS: Fetcher;
  DB: D1Database;
}

const PTV_BASE = "https://timetableapi.ptv.vic.gov.au";
const CACHE_SECONDS = 45; // protect PTV rate limits; clients can poll freely
const TRAIN_MAX_RESULTS = 16; // per stop, per route+direction (PTV semantics)

// Fallback when the station query param is missing or unparsable.
const DEFAULT_STATION_STOP_ID = 1072; // Footscray

// station_types whose stop_ids are physically paired and should have their
// departures merged into a single board (see schema.sql).
const MERGE_TYPES = new Set(["flinders_street", "melbourne_central"]);

// ---- Fixed bus stops (always included, independent of chosen station) -----
const BUS_STOPS = [
  { key: "bus-city", label: "Bus - City / Inner North", stopId: 19740, routeType: 2, maxResults: 5 },
  { key: "bus-west", label: "Bus - Footscray / Sunshine", stopId: 20796, routeType: 2, maxResults: 5 },
] as const;

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
interface Departure {
  route: string; // e.g. "Werribee" line or bus number "82"
  destination: string; // direction name
  platform: string | null;
  scheduledUtc: string;
  estimatedUtc: string | null; // null = timetable only
}

interface StopBoard {
  key: string;
  label: string;
  stationType?: string; // train boards only; drives frontend split logic
  stopName: string; // as reported by PTV, for sanity checking
  departures: Departure[];
  error?: string;
}

interface StationRow {
  stop_id: number;
  name: string;
  station_type: string;
}

function byBestTime(a: Departure, b: Departure): number {
  const ta = new Date(a.estimatedUtc ?? a.scheduledUtc).getTime();
  const tb = new Date(b.estimatedUtc ?? b.scheduledUtc).getTime();
  return ta - tb;
}

// ---- Fetch departures for one physical stop -------------------------------
async function fetchDepartures(
  stopId: number,
  routeType: number,
  maxResults: number,
  env: Env,
): Promise<{ departures: Departure[]; stopName: string; error?: string }> {
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

// ---- Train station (possibly multiple merged stops) -----------------------
async function fetchStation(stopId: number, env: Env): Promise<StopBoard> {
  const stationRow = await env.DB.prepare(
    `SELECT stop_id, name, station_type FROM stations WHERE stop_id = ?`,
  ).bind(stopId).first<StationRow>();

  if (!stationRow) {
    return {
      key: "train",
      label: "Unknown station",
      stopName: "",
      departures: [],
      error: `No station found for stop_id ${stopId}`,
    };
  }

  let stopIds = [stationRow.stop_id];
  let label = stationRow.name;

  if (MERGE_TYPES.has(stationRow.station_type)) {
    const { results } = await env.DB.prepare(
      `SELECT stop_id, name FROM stations WHERE station_type = ? ORDER BY stop_id`,
    ).bind(stationRow.station_type).all<{ stop_id: number; name: string }>();
    if (results.length > 0) {
      stopIds = results.map((r) => r.stop_id);
      label = results.map((r) => r.name).join(" / ");
    }
  }

  const results = await Promise.all(
    stopIds.map((id) => fetchDepartures(id, 0, TRAIN_MAX_RESULTS, env)),
  );

  const departures = results.flatMap((r) => r.departures).sort(byBestTime);
  const stopNames = results.map((r) => r.stopName).filter(Boolean).join(" + ");
  const allFailed = results.every((r) => r.error);

  return {
    key: "train",
    label,
    stationType: stationRow.station_type,
    stopName: stopNames,
    departures,
    ...(allFailed ? { error: results[0].error } : {}),
  };
}

// ---- Bus stop --------------------------------------------------------------
async function fetchBus(stop: (typeof BUS_STOPS)[number], env: Env): Promise<StopBoard> {
  const r = await fetchDepartures(stop.stopId, stop.routeType, stop.maxResults, env);
  return {
    key: stop.key,
    label: stop.label,
    stopName: r.stopName,
    departures: r.departures.sort(byBestTime),
    ...(r.error ? { error: r.error } : {}),
  };
}

// ---- Worker entry ---------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // future Pi / e-ink clients welcome
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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

      return new Response(JSON.stringify(picker), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ---- GET /api/board -> departures for a specific train station ----------
    if (url.pathname === "/api/board") {
      const stationParam = url.searchParams.get("station");
      const parsedId = stationParam !== null ? Number(stationParam) : NaN;
      const stopId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : DEFAULT_STATION_STOP_ID;

      // Edge cache per station: many clients on one station share one PTV call
      const cacheKey = new Request(`${url.origin}/api/board?station=${stopId}`);
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const [train, ...buses] = await Promise.all([
        fetchStation(stopId, env),
        ...BUS_STOPS.map((s) => fetchBus(s, env)),
      ]);

      const body = JSON.stringify({
        updatedUtc: new Date().toISOString(),
        station: stopId,
        stops: [train, ...buses],
      });

      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, s-maxage=${CACHE_SECONDS}`,
          ...CORS_HEADERS,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // Everything else: serve the static dashboard
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;