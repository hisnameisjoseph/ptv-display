//
//  Card.swift
//  The user's board: an ordered list of stops, each with its own settings.
//
//  This is a direct port of the `ptv-layout` v2 model in src/frontend/app.ts.
//  The shape is kept identical on purpose - the same JSON is readable by both
//  the web app and this one, so a board configured in Safari can be pasted in
//  here (and, later, synced) without a migration.
//

import Foundation

enum CardMode: String, Codable, Hashable {
    case train
    case bus

    /// PTV route_type. The Worker keys its cache on this.
    var routeType: Int { self == .train ? 0 : 2 }
}

struct Card: Codable, Hashable, Identifiable {
    var id: String
    var mode: CardMode
    var stopId: Int
    /// The pinned card. Exactly one card carries this.
    var primary: Bool?
    /// Portrait only; a shut card shows its next departures in the header.
    var collapsed: Bool?
    /// Departures you could not reach in time are hidden. nil = use the default.
    var walkMinutes: Int?
    /// nil or empty means every route. Matched against Departure.routeId.
    var routeIds: [Int]?

    /// The key the Worker expects in ?stops=
    var stopKey: String { "\(mode.routeType):\(stopId)" }

    static func new(mode: CardMode, stopId: Int) -> Card {
        Card(id: UUID().uuidString, mode: mode, stopId: stopId,
             primary: nil, collapsed: nil, walkMinutes: nil, routeIds: nil)
    }
}

/// The stored envelope, versioned so a future shape change can migrate rather
/// than silently discard someone's board.
struct Layout: Codable {
    var version: Int
    var cards: [Card]
}

// MARK: - Board rules

enum BoardRules {
    static let maxCards = 8
    /// Past this many stops the cards get tight; the add sheet says so.
    static let warnFrom = 5
    static let walkStops = [0, 3, 5, 8, 10, 15]
    static let walkDefault = 5
    static let undoWindow: TimeInterval = 7
    static let refreshInterval: TimeInterval = 45
    /// Below this the search endpoints are not called at all.
    static let minSearchChars = 3
    /// Route numbers listed in a picker row before it says "+N".
    static let busRoutesShown = 5

    /// Rows to build before trimming. Trains get a generous cap because the
    /// landscape board trims to fit; buses are capped by what the Worker sends.
    static func maxFill(_ mode: CardMode) -> Int { mode == .train ? 30 : 12 }

    /// Portrait row budgets, matching PORTRAIT in the web app.
    static let trainRowsPerGroup = 3
    static let trainSingleList = 5
    static let busSummaryTimes = 2
    static let busExpandedRows = 4
}

// MARK: - Persistence

/// UserDefaults rather than a file: the layout is small, changes often, and
/// wants to be readable synchronously at launch so the first paint is correct.
///
/// NOTE for the widget phase: sharing this with a widget extension needs an
/// App Group, which requires a paid developer account. See ios/README.md.
enum LayoutStore {
    static let key = "ptv-layout"
    static let themeKey = "ptv-theme"
    private static let version = 2

    static func load(defaults: UserDefaults = .standard) -> [Card] {
        guard
            let data = defaults.data(forKey: key),
            let stored = try? JSONDecoder().decode(Layout.self, from: data)
        else { return defaultCards() }

        let cards = normalise(stored.cards)
        return cards.isEmpty ? defaultCards() : cards
    }

    static func save(_ cards: [Card], defaults: UserDefaults = .standard) {
        let layout = Layout(version: version, cards: normalise(cards))
        guard let data = try? JSONEncoder().encode(layout) else { return }
        defaults.set(data, forKey: key)
    }

    /// The board a first-time user sees: Footscray plus two nearby bus stops,
    /// the same defaults the web app ships.
    static func defaultCards() -> [Card] {
        var train = Card.new(mode: .train, stopId: 1072)
        train.primary = true
        return [train,
                Card.new(mode: .bus, stopId: 19740),
                Card.new(mode: .bus, stopId: 20796)]
    }

    /// One primary, no duplicate stops, never more than the cap. Applied on
    /// load as well as on save, so a hand-edited or synced board cannot put
    /// the app into a state its own UI could not produce.
    static func normalise(_ input: [Card]) -> [Card] {
        var seen = Set<String>()
        var out: [Card] = []

        for var card in input {
            guard out.count < BoardRules.maxCards else { break }
            guard seen.insert(card.stopKey).inserted else { continue }
            if card.id.isEmpty { card.id = UUID().uuidString }
            out.append(card)
        }

        if out.isEmpty { return out }
        if !out.contains(where: { $0.primary == true }) {
            out[0].primary = true
        } else {
            // Exactly one, and the first claim wins.
            var found = false
            for i in out.indices {
                if out[i].primary == true {
                    if found { out[i].primary = nil } else { found = true }
                }
            }
        }
        return out
    }
}
