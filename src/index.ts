/**
 * PTV Departures Board - Cloudflare Worker
 *
 * Endpoints:
 *   GET /api/board  -> departures for all configured stops (single call for clients)
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

// ---- Your stops -----------------------------------------------------------
// maxResults must be >= the client's maxShown PLUS a buffer, because the
// client hides departures inside your walk time and already-departed ones.
const STOPS = [
  { key: "train", label: "Footscray Station", stopId: 1072, routeType: 0, maxResults: 12 },
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

// ---- Fetch one stop -------------------------------------------------------
async function fetchStop(
  stop: (typeof STOPS)[number],
  env: Env,
): Promise<StopBoard> {
  const path =
    `/v3/departures/route_type/${stop.routeType}/stop/${stop.stopId}` +
    `?max_results=${stop.maxResults}&expand=stop&expand=route&expand=direction`;

  try {
    const res = await fetch(await signedUrl(path, env));
    if (!res.ok) {
      return {
        key: stop.key,
        label: stop.label,
        stopName: "",
        departures: [],
        error: `PTV returned HTTP ${res.status}`,
      };
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

    // PTV can return departures out of order across routes; sort by best time
    departures.sort((a, b) => {
      const ta = new Date(a.estimatedUtc ?? a.scheduledUtc).getTime();
      const tb = new Date(b.estimatedUtc ?? b.scheduledUtc).getTime();
      return ta - tb;
    });

    return {
      key: stop.key,
      label: stop.label,
      stopName: data.stops?.[stop.stopId]?.stop_name ?? "unknown",
      departures,
    };
  } catch (err) {
    return {
      key: stop.key,
      label: stop.label,
      stopName: "",
      departures: [],
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
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
      // Edge cache so many refreshes = one PTV call per ~45s
      const cacheKey = new Request(`${url.origin}/api/board`);
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const stops = await Promise.all(STOPS.map((s) => fetchStop(s, env)));
      const body = JSON.stringify({
        updatedUtc: new Date().toISOString(),
        stops,
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