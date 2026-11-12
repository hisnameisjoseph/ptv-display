//
//  SplitConfig.swift
//  Which way is a train going, and does this station need two columns?
//
//  A direct port of STATION_TYPE_SPLIT in src/frontend/app.ts. This is the
//  only real domain knowledge in the client: PTV gives a direction name, not
//  a "citybound" flag, so each station type carries a rule for sorting its
//  departures into two readable groups.
//
//  A terminus has no split - almost everything leaving is city-bound - so it
//  gets one chronological list under an "All services" band instead.
//

import Foundation

enum ColumnSide { case left, right }

/// Which field a side's rule tests. Some stations split by where a train is
/// going, others by which line it is on.
enum SplitField { case destination, route }

struct SplitSide {
    let label: String
    /// Exactly one side of a config carries a pattern; the other is the
    /// fallback. Case-insensitive substring alternation, as in the web app.
    let match: [String]?
    let field: SplitField

    init(_ label: String, match: [String]? = nil, field: SplitField = .destination) {
        self.label = label
        self.match = match
        self.field = field
    }
}

struct SplitConfig {
    let left: SplitSide
    let right: SplitSide
    /// Which side is city-bound, where that is meaningful. Portrait shows the
    /// likely-wanted direction first: towards town in the morning, away after.
    let cityWard: ColumnSide?

    init(left: SplitSide, right: SplitSide, cityWard: ColumnSide? = nil) {
        self.left = left
        self.right = right
        self.cityWard = cityWard
    }

    func side(_ s: ColumnSide) -> SplitSide { s == .left ? left : right }

    /// Sort one departure into a column.
    func column(for dep: Departure) -> ColumnSide {
        if let patterns = left.match {
            return matches(dep, patterns, left.field) ? .left : .right
        }
        if let patterns = right.match {
            return matches(dep, patterns, right.field) ? .right : .left
        }
        return .left
    }

    private func matches(_ dep: Departure, _ patterns: [String], _ field: SplitField) -> Bool {
        let value = (field == .route ? dep.route : dep.destination).lowercased()
        return patterns.contains { value.contains($0.lowercased()) }
    }

    /// The order the two groups are stacked in portrait.
    func orderedSides(now: Date = Date(), calendar: Calendar = .current) -> [ColumnSide] {
        guard let cityWard else { return [.left, .right] }
        let morning = calendar.component(.hour, from: now) < 12
        let first: ColumnSide = morning
            ? cityWard
            : (cityWard == .left ? .right : .left)
        return first == .left ? [.left, .right] : [.right, .left]
    }
}

enum Splits {
    static let city = SplitConfig(
        left: SplitSide("Outbound"),
        right: SplitSide("To City", match: ["city", "flinders"]),
        cityWard: .right)

    static let tunnelNorth = SplitConfig(
        left: SplitSide("To Sunbury", match: ["sunbury"]),
        right: SplitSide("To City / Cranbourne / Pakenham"),
        cityWard: .right)

    static let tunnelSouth = SplitConfig(
        left: SplitSide("To City / Sunbury", match: ["sunbury", "city"]),
        right: SplitSide("To Cranbourne / Pakenham"),
        cityWard: .left)

    static let southernCross = SplitConfig(
        left: SplitSide("Red / Yellow / Dark Blue"),
        right: SplitSide("Frankston / Cross-City",
                         match: ["sandringham", "frankston", "werribee", "williamstown"],
                         field: .route))

    static let flindersStreet = SplitConfig(
        left: SplitSide("Red / Yellow / Dark Blue"),
        right: SplitSide("Cross-City / Frankston",
                         match: ["werribee", "williamstown", "sandringham",
                                 "sunbury", "pakenham", "cranbourne", "frankston"],
                         field: .route))

    static let melbourneCentral = SplitConfig(
        left: SplitSide("Red / Yellow / Dark Blue"),
        right: SplitSide("Metro Tunnel & Frankston",
                         match: ["sunbury", "pakenham", "cranbourne", "frankston"],
                         field: .route))

    static let northLoop = SplitConfig(
        left: SplitSide("Burnley / Craigieburn / Upfield"),
        right: SplitSide("Hurstbridge / Mernda / Frankston",
                         match: ["hurstbridge", "mernda", "frankston"],
                         field: .route))

    /// The band shown above a single chronological list. A terminus is not
    /// purely city-bound everywhere - Frankston also runs to Stony Point - so
    /// this says something that is true at every terminus rather than guessing.
    static let singleListBand = "All services"

    /// station_type from D1 -> split rule. nil means one chronological list.
    static func forStationType(_ type: String?) -> SplitConfig? {
        guard let type else { return nil }
        switch type {
        case "through", "interchange":  return city
        case "terminus":                return nil
        case "loop":                    return northLoop
        case "tunnel_north":            return tunnelNorth
        case "tunnel_south":            return tunnelSouth
        case "flinders_street":         return flindersStreet
        case "southern_cross":          return southernCross
        case "melbourne_central":       return melbourneCentral
        default:
            // An unmapped type from the API is a data change, not a crash.
            // One list is always a safe rendering.
            return nil
        }
    }
}
