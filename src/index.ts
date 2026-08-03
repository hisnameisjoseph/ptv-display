/**
 * PTV Departures Board - Cloudflare Worker
 *
 * Endpoints:
 *   GET /api/board?station=<stop_id>&bus1=<stop_id>&bus2=<stop_id>
 *                                     -> departures for the chosen train
 *                                        station plus two bus stops. All
 *                                        params optional; each falls back to
 *                                        a default.
 *   GET /api/stations                 -> picker-ready list of all metro
 *                                        stations, with flinders_street and
 *                                        melbourne_central pairs merged into
 *                                        a single entry each.
 *   GET /api/stops/search?q=<term>    -> up to 20 metro bus stops matching
 *                                        the term as a subsequence, ranked
 *                                        prefix > substring > subsequence.
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
const BUS_MAX_RESULTS = 5;

// Fallback when a station query param is missing or unparsable.
const DEFAULT_STATION_STOP_ID = 1072; // Footscray

// Bus slots. The keys are stable slot identifiers, NOT descriptions of a
// particular stop - the CSS grid and the frontend both key off them, while
// the stop behind each slot is user-configurable.
const BUS_SLOTS = [
  { key: "bus-1", defaultStopId: 19740 },
  { key: "bus-2", defaultStopId: 20796 },
] as const;

// station_types whose stop_ids are physically paired and should have their
// departures merged into a single board (see schema.sql).
const MERGE_TYPES = new Set(["flinders_street", "melbourne_central"]);

// Bus stop search tuning. Must match MIN_SEARCH_CHARS in the frontend.
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
  stopId?: number; // bus boards only; lets the frontend mark the active pick
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

function parseStopId(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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

// ---- Bus stops -------------------------------------------------------------
// One D1 round trip for both slot labels, rather than one per slot.
async function busLabels(stopIds: number[], env: Env): Promise<Map<number, string>> {
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

async function fetchBus(
  key: string,
  stopId: number,
  labels: Map<number, string>,
  env: Env,
): Promise<StopBoard> {
  const r = await fetchDepartures(stopId, 2, BUS_MAX_RESULTS, env);
  return {
    key,
    // Prefer our own imported name; fall back to whatever PTV reported.
    label: labels.get(stopId) ?? r.stopName ?? `Stop ${stopId}`,
    stopId,
    stopName: r.stopName,
    departures: r.departures.sort(byBestTime),
    ...(r.error ? { error: r.error } : {}),
  };
}

// ---- Bus stop search -------------------------------------------------------
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

    // ---- GET /api/board -> departures for a train station + two bus stops ---
    if (url.pathname === "/api/board") {
      const stopId = parseStopId(url.searchParams.get("station")) ?? DEFAULT_STATION_STOP_ID;
      const busIds = BUS_SLOTS.map(
        (slot, i) => parseStopId(url.searchParams.get(`bus${i + 1}`)) ?? slot.defaultStopId,
      );

      // Edge cache per unique combination. Many clients on the same setup
      // share one set of PTV calls; different setups simply cache separately.
      const cacheKey = new Request(
        `${url.origin}/api/board?station=${stopId}&bus1=${busIds[0]}&bus2=${busIds[1]}`,
      );
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const labels = await busLabels(busIds, env);

      const [train, ...buses] = await Promise.all([
        fetchStation(stopId, env),
        ...BUS_SLOTS.map((slot, i) => fetchBus(slot.key, busIds[i], labels, env)),
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