//
//  APITypes.swift
//  Wire format for the Cloudflare Worker. These mirror the interfaces in
//  src/index.ts exactly; if that file changes, this one has to change with it.
//
//  Everything is decoded straight from the Worker rather than from PTV. The
//  Worker has already done the signing, the per-stop caching, the Flinders
//  Street / Melbourne Central merge and the sort, so the app never talks to
//  PTV and never holds a credential.
//

import Foundation

/// One service leaving one stop.
struct Departure: Codable, Hashable, Identifiable {
    /// A line name for trains ("Werribee"), a route number for buses ("82").
    let route: String
    /// PTV route_id. The route filter matches on this, never on the label,
    /// because two different routes can share a display name.
    let routeId: Int
    let destination: String
    let platform: String?
    let scheduledUtc: Date
    /// nil means timetable only - PTV has no live estimate for this service.
    let estimatedUtc: Date?

    /// The time to actually count down to.
    var bestTime: Date { estimatedUtc ?? scheduledUtc }

    /// Minutes late, rounded. Zero when there is no estimate to compare.
    var lateByMinutes: Int {
        guard let estimatedUtc else { return 0 }
        return Int((estimatedUtc.timeIntervalSince(scheduledUtc) / 60).rounded())
    }

    /// Stable within a board refresh, which is all a ForEach needs.
    var id: String { "\(routeId)-\(destination)-\(scheduledUtc.timeIntervalSince1970)" }
}

/// One stop's worth of board, as returned inside /api/board.
struct StopBoard: Codable, Hashable, Identifiable {
    /// "0:1072" - routeType:stopId. Matches Card.stopKey.
    let key: String
    let mode: CardMode
    let routeType: Int
    let stopId: Int
    /// Display name, already merged for Flinders Street / Melbourne Central.
    let label: String
    /// Train boards only. Drives the direction split - see SplitConfig.
    let stationType: String?
    let stopName: String
    let fetchedUtc: Date
    let departures: [Departure]
    /// Present when the upstream fetch failed. Departures will be empty.
    let error: String?

    var id: String { key }
}

/// The /api/board envelope.
struct BoardPayload: Codable {
    let updatedUtc: Date
    /// When the oldest stop behind this board goes stale. The refresh loop
    /// uses it so a board is not re-fetched while every stop is still fresh.
    let staleAtUtc: Date?
    let stops: [StopBoard]
}

/// A result from the unified picker, /api/search.
struct SearchHit: Codable, Hashable, Identifiable {
    let mode: CardMode
    let routeType: Int
    let stopId: Int
    let label: String
    let suburb: String?
    let stationType: String?
    let routes: [RouteRef]

    var id: String { "\(routeType):\(stopId)" }
}

struct RouteRef: Codable, Hashable {
    let id: Int
    let label: String
}

/// A row from /api/stations, used by the train picker.
struct StationEntry: Codable, Hashable, Identifiable {
    /// stop_id; the lowest of the pair for a merged station.
    let key: Int
    let label: String
    let stationType: String

    var id: Int { key }
}

/// A row from /api/stops/search, used by the per-card bus picker.
struct BusStopHit: Codable, Hashable, Identifiable {
    let stopId: Int
    let label: String
    let suburb: String?
    let routes: [String]

    var id: Int { stopId }
}
