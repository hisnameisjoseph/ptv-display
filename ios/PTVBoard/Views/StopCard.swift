//
//  StopCard.swift
//  One stop, with its header, its direction bands and its rows.
//
//  The card measures itself and picks a density tier from that measurement,
//  not from the device or the orientation - so a wide primary card and a
//  cramped secondary on the same screen render at different tiers.
//

import SwiftUI

struct StopCard: View {
    let card: Card
    let index: Int
    /// Landscape packs cards into a grid and trims to fit; portrait scrolls.
    let isGrid: Bool

    @EnvironmentObject private var store: BoardStore
    @Environment(\.palette) private var palette

    @State private var measured: CGSize = .zero

    private var tier: DensityTier { DensityTier.forCard(measured) }
    private var metrics: DensityMetrics { DensityMetrics.of(tier) }
    private var stop: StopBoard? { store.board(for: card) }
    private var collapsed: Bool { !isGrid && store.isCollapsed(card) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if store.editMode { EditBar(card: card, index: index) }
            if !collapsed { content }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(store.editMode ? palette.editingCard : palette.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: Radius.xl, style: .continuous))
        .background(
            // The measurement that drives density. Reading it from a
            // background keeps it out of the layout pass it is measuring.
            GeometryReader { proxy in
                Color.clear.preference(key: CardSizeKey.self, value: proxy.size)
            })
        .onPreferenceChange(CardSizeKey.self) { measured = $0 }
        .environment(\.density, metrics)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: Space.s2) {
            Button {
                // Tapping the name opens the stop picker - phase B.
            } label: {
                HStack(spacing: 6) {
                    Text(StopName.cardTitle(stop?.label ?? "…", mode: card.mode))
                        .font(FontFamily.display(metrics.headerSize, .semibold))
                        .foregroundStyle(palette.fg)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(palette.fgSecondary)
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: Space.s2)

            // A shut card is already spending its header on the summary times,
            // and the chip would take the width the stop name needs. It comes
            // back the moment the card is opened.
            if isGrid || !collapsed {
                if let chip = filterChipText { FilterChip(text: chip) }
            } else if let stop {
                CollapsedSummary(card: card, stop: stop)
            }

            if !isGrid {
                Button {
                    store.toggleCollapsed(card)
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(palette.fgSecondary)
                        .rotationEffect(.degrees(collapsed ? -90 : 0))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .animation(.easeInOut(duration: 0.15), value: collapsed)
            }
        }
        .padding(.horizontal, tier == .glance ? Space.s3 : Space.s4)
        .padding(.vertical, tier == .glance ? Space.s2 : Space.s3)
        .frame(minHeight: tier == .glance ? 0 : 44)
    }

    private var filterChipText: String? {
        let walk = store.walk(for: card)
        let routes = card.routeIds?.count ?? 0
        if walk == 0 && routes == 0 { return nil }
        var bits: [String] = []
        if walk > 0 { bits.append("\(walk) min walk") }
        if routes > 0 { bits.append("\(routes) routes") }
        return bits.joined(separator: " · ")
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let stop {
            if let error = stop.error {
                Text("Data unavailable. \(error)")
                    .font(TypeRole.subheadline)
                    .foregroundStyle(palette.inkLate)
                    .padding(Space.s4)
            } else {
                let visible = store.visibleDepartures(for: card, from: stop)
                let split = card.mode == .train
                    ? Splits.forStationType(stop.stationType)
                    : nil
                let rail = RailWidth.needed(for: visible, metrics: metrics, now: store.now)

                if let split, sideBySide {
                    HStack(spacing: 0) {
                        column(split.side(.left), visible.filter { split.column(for: $0) == .left }, rail)
                        Rectangle()
                            .fill(palette.hairline)
                            .frame(width: 1)
                        column(split.side(.right), visible.filter { split.column(for: $0) == .right }, rail)
                    }
                } else if let split {
                    VStack(spacing: 0) {
                        ForEach(split.orderedSides(now: store.now), id: \.self) { side in
                            column(split.side(side),
                                   visible.filter { split.column(for: $0) == side },
                                   rail)
                        }
                    }
                } else {
                    // A terminus has one direction, so it has no split - but
                    // without a band it is the only card that opens with a bare
                    // row where every other card opens with a heading.
                    column(SplitSide(Splits.singleListBand), visible, rail)
                }
            }
        } else {
            Text("Loading…")
                .font(TypeRole.subheadline)
                .foregroundStyle(palette.fgSecondary)
                .padding(Space.s4)
        }
    }

    private var sideBySide: Bool {
        isGrid && measured.width >= DensityTier.splitMinWidth
    }

    private func column(_ side: SplitSide, _ departures: [Departure], _ rail: CGFloat) -> some View {
        let cap = isGrid
            ? BoardRules.maxFill(card.mode)
            : (card.mode == .train ? BoardRules.trainRowsPerGroup : BoardRules.busExpandedRows)
        let shown = Array(departures.prefix(cap))

        return VStack(alignment: .leading, spacing: 0) {
            DirectionBand(label: side.label)
            if shown.isEmpty {
                Text("No departures")
                    .font(TypeRole.subheadline)
                    .foregroundStyle(palette.fgSecondary)
                    .padding(.horizontal, metrics.rowPadH)
                    .padding(.vertical, metrics.rowPadV)
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { offset, dep in
                    if offset > 0 {
                        // Inset past the rail, so the column of numerals reads
                        // as one unbroken run.
                        Rectangle()
                            .fill(palette.hairline)
                            .frame(height: 1)
                            .padding(.leading, rail + metrics.rowPadH + metrics.rowGap)
                    }
                    DepartureRow(departure: dep,
                                 mode: card.mode,
                                 railWidth: rail,
                                 walkMinutes: store.walk(for: card),
                                 now: store.now)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Pieces

/// An overline on a band. The band is what separates the group, so there is
/// no rule underneath it.
struct DirectionBand: View {
    let label: String
    @Environment(\.palette) private var palette
    @Environment(\.density) private var density

    var body: some View {
        Text(label)
            .overline(size: density.bandSize, tracking: 0.6, colour: palette.fgSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, density.rowPadH)
            .padding(.vertical, 6)
            .background(palette.bgBand)
    }
}

/// The next service in each direction, for a card that is shut.
struct CollapsedSummary: View {
    let card: Card
    let stop: StopBoard

    @EnvironmentObject private var store: BoardStore
    @Environment(\.palette) private var palette

    var body: some View {
        let visible = store.visibleDepartures(for: card, from: stop)
        let split = card.mode == .train ? Splits.forStationType(stop.stationType) : nil
        let picked = summary(visible, split)

        HStack(spacing: Space.s3) {
            ForEach(picked) { dep in
                HStack(spacing: 5) {
                    LineBadge(route: dep.route, mode: card.mode)
                    Text(Countdown.short(minutes: Countdown.minutesUntil(dep.bestTime, now: store.now)))
                        .font(FontFamily.display(17, .bold))
                        .monospacedDigit()
                        .foregroundStyle(palette.inkCount)
                }
            }
            if picked.isEmpty {
                Text(stop.error == nil ? "none" : "no data")
                    .font(TypeRole.footnote())
                    .foregroundStyle(palette.fgSecondary)
            }
        }
        .environment(\.density, DensityMetrics.compact)
        .fixedSize()
    }

    /// A split station shows the next service in EACH direction: two
    /// chronological departures could both be heading the same way, which is
    /// exactly the case where a summary misleads.
    private func summary(_ departures: [Departure], _ split: SplitConfig?) -> [Departure] {
        guard let split else { return Array(departures.prefix(BoardRules.busSummaryTimes)) }
        var picked: [Departure] = []
        for side in split.orderedSides(now: store.now) {
            if let next = departures.first(where: { split.column(for: $0) == side }) {
                picked.append(next)
            }
        }
        return picked.isEmpty
            ? Array(departures.prefix(BoardRules.busSummaryTimes))
            : Array(picked.prefix(BoardRules.busSummaryTimes))
    }
}

/// A card must never hide departures for a reason you cannot see.
struct FilterChip: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(TypeRole.footnote())
            .foregroundStyle(palette.fgSecondary)
            .padding(.horizontal, Space.s3)
            .frame(height: 28)
            .background(palette.bgBand, in: Capsule())
            .fixedSize()
    }
}

private struct CardSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}
