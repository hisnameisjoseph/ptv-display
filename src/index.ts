/**
 * PTV Departures Board - Cloudflare Worker
 *
 * Endpoints:
 *   GET /api/board?station=<key>  -> departures for the chosen train station
 *                                    plus the fixed Footscray bus stops.
 *                                    station defaults to "footscray".
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
}

const PTV_BASE = "https://timetableapi.ptv.vic.gov.au";
const CACHE_SECONDS = 45; // protect PTV rate limits; clients can poll freely
const TRAIN_MAX_RESULTS = 12; // per stop, per route+direction (PTV semantics)

// ---- Train stations available in the picker -------------------------------
// Multi-ID entries are physically-paired stations; their departures merge.
// Keys must match the frontend STATIONS registry.
const STATIONS: Record<string, { label: string; stopIds: number[] }> = {
  "footscray":         { label: "Footscray Station",                stopIds: [1072] },
  "flinders-street":   { label: "Flinders St / Town Hall",          stopIds: [1071, 1235] },
  "melbourne-central": { label: "Melbourne Central / State Library", stopIds: [1120, 1234] },
  "southern-cross":    { label: "Southern Cross",                   stopIds: [1181] },
  "flagstaff":         { label: "Flagstaff Station",                stopIds: [1068] },
  "parliament":        { label: "Parliament Station",               stopIds: [1155] },
  "anzac":             { label: "Anzac Station",                    stopIds: [1236] },
  "parkville":         { label: "Parkville Station",                stopIds: [1233] },
  "arden":             { label: "Arden Station",                    stopIds: [1232] },
  "richmond":          { label: "Richmond Station",                 stopIds: [1162] },
  "west-richmond":     { label: "West Richmond",                    stopIds: [1207] },
  "jolimont":          { label: "Jolimont-MCG Station",             stopIds: [1104] },
  "south-yarra":       { label: "South Yarra",                      stopIds: [1180] },
  "caulfield":         { label: "Caulfield Station",                stopIds: [1036] },
  "newport":           { label: "Newport Station",                  stopIds: [1141] },
  "yarraville":        { label: "Yarraville Station",               stopIds: [1216] },
  "sunshine":          { label: "Sunshine Station",                 stopIds: [1218] },
  "werribee":          { label: "Werribee Station",                 stopIds: [1205] },
  "middle-footscray":  { label: "Middle Footscray",                 stopIds: [1127] },
  "west-footscray":    { label: "West Footscray",                   stopIds: [1206] },
  // FIXME: 1127 is Middle Footscray's ID. Look up the real North Richmond
  // stop_id before re-enabling, e.g. with a signed request to:
  //   /v3/search/north%20richmond?route_types=0
  // then restore this entry with the correct ID.
  // "north-richmond":  { label: "North Richmond",                  stopIds: [TODO] },
  "hawksburn":         { label: "Hawksburn Station",                stopIds: [1089] },
  "watergardens":      { label: "Watergardens Station",             stopIds: [1202] },
  "flemington-bridge": { label: "Flemington Bridge",                stopIds: [1069] },
  "macaulay":          { label: "Macaulay Station",                 stopIds: [1116] },
};
const DEFAULT_STATION = "footscray";

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
  stopName: string; // as reported by PTV, for sanity checking
  departures: Departure[];
  error?: string;
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
async function fetchStation(stationKey: string, env: Env): Promise<StopBoard> {
  const station = STATIONS[stationKey];
  const results = await Promise.all(
    station.stopIds.map((id) => fetchDepartures(id, 0, TRAIN_MAX_RESULTS, env)),
  );

  const departures = results.flatMap((r) => r.departures).sort(byBestTime);
  const stopNames = results.map((r) => r.stopName).filter(Boolean).join(" + ");
  const allFailed = results.every((r) => r.error);

  return {
    key: "train",
    label: station.label,
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

    if (url.pathname === "/api/board") {
      const requested = url.searchParams.get("station") ?? DEFAULT_STATION;
      const stationKey = requested in STATIONS ? requested : DEFAULT_STATION;

      // Edge cache per station: many clients on one station share one PTV call
      const cacheKey = new Request(`${url.origin}/api/board?station=${stationKey}`);
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const [train, ...buses] = await Promise.all([
        fetchStation(stationKey, env),
        ...BUS_STOPS.map((s) => fetchBus(s, env)),
      ]);

      const body = JSON.stringify({
        updatedUtc: new Date().toISOString(),
        station: stationKey,
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