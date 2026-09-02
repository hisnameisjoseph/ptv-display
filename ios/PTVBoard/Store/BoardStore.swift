//
//  BoardStore.swift
//  All mutable app state, in one observable object.
//
//  The web app keeps this in module-level variables and re-renders the whole
//  board on every change. SwiftUI does the diffing, so the equivalent here is
//  a single source of truth that views observe.
//

import Foundation
import SwiftUI
// @Published and ObservableObject are Combine's, not SwiftUI's. Swift 6 turns on
// member import visibility (SE-0444): a member is only usable if the module that
// DECLARES it is imported by name, never through a re-export. Without this line
// every @Published below fails with "init(wrappedValue:) is not available", and
// the ObservableObject conformance fails as a cascade of those.
import Combine

@MainActor
final class BoardStore: ObservableObject {

    // MARK: - Published state

    @Published private(set) var cards: [Card]
    @Published private(set) var payload: BoardPayload?
    @Published private(set) var isLoading = false
    /// Set when a refresh fails. The previous payload stays on screen - a
    /// stale board is still readable, because every row carries an absolute
    /// time as well as a countdown.
    @Published private(set) var lastError: String?

    @Published var editMode = false
    @Published var theme: ThemeChoice {
        didSet { UserDefaults.standard.set(theme.rawValue, forKey: LayoutStore.themeKey) }
    }

    /// Ticks once a minute so countdowns move without a network round trip.
    @Published private(set) var now = Date()

    /// A removed card, recoverable for a few seconds.
    @Published private(set) var pendingUndo: (card: Card, index: Int)?

    // MARK: - Private

    private let client: BoardClient
    private var refreshTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private var undoTask: Task<Void, Never>?

    init(client: BoardClient = BoardClient()) {
        self.client = client
        self.cards = LayoutStore.load()
        let stored = UserDefaults.standard.string(forKey: LayoutStore.themeKey)
        self.theme = ThemeChoice(rawValue: stored ?? "") ?? .dark
    }

    // MARK: - Lifecycle

    /// Start the refresh and tick loops. Safe to call more than once.
    func start() {
        guard refreshTask == nil else { return }

        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64(BoardRules.refreshInterval * 1_000_000_000))
            }
        }

        // A countdown only changes on the minute, so tick on the minute rather
        // than every second: same result, a fraction of the wakeups.
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                let secondsToNextMinute = 60 - (Calendar.current.component(.second, from: Date()))
                try? await Task.sleep(nanoseconds: UInt64(secondsToNextMinute) * 1_000_000_000)
                await MainActor.run { self?.now = Date() }
            }
        }
    }

    /// Called when the app leaves the foreground. A board nobody is looking at
    /// should not be polling every 45 seconds.
    func stop() {
        refreshTask?.cancel(); refreshTask = nil
        tickTask?.cancel(); tickTask = nil
    }

    func refresh() async {
        guard !cards.isEmpty else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            payload = try await client.board(for: cards)
            lastError = nil
            now = Date()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Reading

    func board(for card: Card) -> StopBoard? {
        payload?.stops.first { $0.key == card.stopKey }
    }

    var primaryCard: Card? {
        cards.first { $0.primary == true } ?? cards.first
    }

    /// Minutes of walking to hide, for this card.
    func walk(for card: Card) -> Int {
        card.walkMinutes ?? BoardRules.walkDefault
    }

    /// The departures a card should actually show: route filter applied, then
    /// anything you could not reach in time dropped.
    func visibleDepartures(for card: Card, from stop: StopBoard) -> [Departure] {
        let hideWithin = walk(for: card)
        let allowed = card.routeIds.flatMap { $0.isEmpty ? nil : Set($0) }

        return stop.departures.filter { dep in
            if let allowed, !allowed.contains(dep.routeId) { return false }
            return Countdown.minutesUntil(dep.bestTime, now: now) >= hideWithin
        }
    }

    /// Every route serving this stop, taken from the UNFILTERED payload so a
    /// filter can never hide the option needed to undo it.
    func routeOptions(for stop: StopBoard) -> [RouteRef] {
        var seen = Set<Int>()
        var out: [RouteRef] = []
        for dep in stop.departures where seen.insert(dep.routeId).inserted {
            out.append(RouteRef(id: dep.routeId, label: dep.route))
        }
        return out.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    func isCollapsed(_ card: Card) -> Bool { card.collapsed == true }

    // MARK: - Mutations
    // Each one writes the layout. Only the ones that change which stops the
    // board asks for trigger a refetch.

    func move(from index: Int, by delta: Int) {
        let to = index + delta
        guard cards.indices.contains(index), cards.indices.contains(to) else { return }
        cards.swapAt(index, to)
        persist()
    }

    func setPrimary(_ card: Card) {
        for i in cards.indices { cards[i].primary = (cards[i].id == card.id) ? true : nil }
        persist()
    }

    func toggleCollapsed(_ card: Card) {
        guard let i = cards.firstIndex(where: { $0.id == card.id }) else { return }
        cards[i].collapsed = isCollapsed(card) ? nil : true
        persist()
    }

    func setWalk(_ minutes: Int, for card: Card) {
        guard let i = cards.firstIndex(where: { $0.id == card.id }) else { return }
        cards[i].walkMinutes = max(0, minutes)
        persist()
    }

    /// Toggle one route on a card. Turning the last one back on clears the
    /// filter entirely rather than storing every id.
    func toggleRoute(_ routeId: Int, for card: Card, allIds: [Int]) {
        guard let i = cards.firstIndex(where: { $0.id == card.id }) else { return }
        var selected = Set(cards[i].routeIds ?? allIds)
        if selected.contains(routeId) { selected.remove(routeId) } else { selected.insert(routeId) }

        if selected.isEmpty || selected == Set(allIds) {
            cards[i].routeIds = nil
        } else {
            cards[i].routeIds = allIds.filter { selected.contains($0) }
        }
        persist()
    }

    func setStop(_ stopId: Int, for card: Card) {
        guard let i = cards.firstIndex(where: { $0.id == card.id }) else { return }
        guard cards[i].stopId != stopId else { return }
        cards[i].stopId = stopId
        // A different stop means the old route filter no longer refers to
        // anything that exists.
        cards[i].routeIds = nil
        persist()
        Task { await refresh() }
    }

    @discardableResult
    func add(_ hit: SearchHit) -> Bool {
        guard cards.count < BoardRules.maxCards else { return false }
        guard !cards.contains(where: { $0.mode == hit.mode && $0.stopId == hit.stopId }) else {
            return false
        }
        var card = Card.new(mode: hit.mode, stopId: hit.stopId)
        // A new card announces itself without shoving the rest down the page.
        card.collapsed = true
        cards.append(card)
        persist()
        Task { await refresh() }
        return true
    }

    /// Removal is undoable for a few seconds rather than confirmed up front.
    func remove(_ card: Card) {
        guard cards.count > 1,
              let index = cards.firstIndex(where: { $0.id == card.id }) else { return }

        cards.remove(at: index)
        if !cards.contains(where: { $0.primary == true }) { cards[0].primary = true }
        persist()

        pendingUndo = (card, index)
        undoTask?.cancel()
        undoTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(BoardRules.undoWindow * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.pendingUndo = nil }
        }
    }

    func undoRemove() {
        guard let pending = pendingUndo else { return }
        undoTask?.cancel()
        pendingUndo = nil
        var restored = cards
        restored.insert(pending.card, at: min(pending.index, restored.count))
        cards = LayoutStore.normalise(restored)
        persist()
        Task { await refresh() }
    }

    private func persist() {
        cards = LayoutStore.normalise(cards)
        LayoutStore.save(cards)
    }
}
