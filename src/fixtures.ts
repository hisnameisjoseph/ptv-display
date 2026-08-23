/**
 * Captured PTV departure patterns, replayed by src/mock.ts.
 *
 * This file is GENERATED. Run `node capture-fixtures.mjs` with PTV credentials
 * to overwrite it with real data; the empty default below is intentional and
 * perfectly usable — mock mode falls back to a generated timetable built from
 * the routes in D1 for any stop that has no fixture here.
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
export const FIXTURES: Record<string, FixtureStop> = {};