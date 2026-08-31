//
//  DepartureRow.swift
//  The countdown, then the service.
//
//  The numeral sits on a rail of its own on the left, larger and heavier than
//  anything else in the row, because it is the one thing being read.
//  Everything that qualifies it - the line, where it is going, which platform,
//  whether the time can be trusted - follows to its right.
//

import SwiftUI

struct DepartureRow: View {
    let departure: Departure
    let mode: CardMode
    /// Shared by every row in the card so the numerals line up.
    let railWidth: CGFloat
    /// Minutes of walk being hidden; a departure at or inside it reads as
    /// "going now" and turns green.
    let walkMinutes: Int
    let now: Date

    @Environment(\.palette) private var palette
    @Environment(\.density) private var density

    /// A service is only called late once it has slipped past rounding noise.
    private static let lateThreshold = 2

    private var minutes: Int { Countdown.minutesUntil(departure.bestTime, now: now) }
    private var isImminent: Bool { minutes <= walkMinutes + 1 }

    var body: some View {
        HStack(alignment: .center, spacing: density.rowGap) {
            rail
                .frame(width: railWidth)
            body_
        }
        .padding(.vertical, density.rowPadV)
        .padding(.horizontal, density.rowPadH)
    }

    // MARK: - Rail

    @ViewBuilder
    private var rail: some View {
        let parts = Countdown.parts(minutes: minutes)
        let numeral = Text(parts.value)
            .font(FontFamily.display(density.minsSize, .bold))
            .monospacedDigit()
            .kerning(-0.02 * density.minsSize)
            .foregroundStyle(isImminent ? palette.inkLive : palette.inkCount)
        let unit = Text(parts.unit)
            .overline(size: density.unitSize, tracking: density.unitTracking,
                      colour: palette.fgSecondary)

        if density.inlineUnit {
            // Glance: the unit moves beside the numeral. Same two roles, one
            // line - which is what buys back the height a short card needs.
            HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                Spacer(minLength: 0)
                numeral
                unit
            }
        } else {
            VStack(spacing: 0) {
                numeral
                unit
            }
        }
    }

    // MARK: - Body

    private var body_: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: Space.s2) {
                LineBadge(route: departure.route, mode: mode)
                Text(departure.destination)
                    .font(FontFamily.display(density.nameSize, .bold))
                    .kerning(-0.01 * density.nameSize)
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if density.showsMetadata {
                metadata
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Facts separated by a dim interpunct. A late service says so in words as
    /// well as in colour, with the time it replaced struck through beside it -
    /// colour alone would say something is wrong without saying what.
    private var metadata: some View {
        let late = departure.lateByMinutes
        var line = Text("")

        if let platform = departure.platform, !platform.isEmpty {
            line = line
                + Text("Platform ").foregroundStyle(palette.fgTertiary)
                // Mixed weight inside one line: the number is the part being
                // looked for.
                + Text(platform).foregroundStyle(palette.fg)
                    .font(FontFamily.ui(density.metaSize, .semibold)).monospacedDigit()
                + separator
        }

        if late >= Self.lateThreshold {
            line = line
                + Text("\(late) min late")
                    .foregroundStyle(palette.inkLate)
                    .font(FontFamily.ui(density.metaSize, .semibold))
                + separator
                + Text(ClockFormat.time(departure.scheduledUtc))
                    .foregroundStyle(palette.fgSecondary)
                    .strikethrough(true, color: palette.fgSecondary)
                + Text(" " + ClockFormat.time(departure.bestTime))
                    .foregroundStyle(palette.fgTertiary)
        } else {
            let isLive = departure.estimatedUtc != nil
            line = line
                + Text(isLive ? "Live" : "Scheduled")
                    .foregroundStyle(isLive ? palette.inkLive : palette.fgTertiary)
                    .font(FontFamily.ui(density.metaSize, isLive ? .semibold : .regular))
                + separator
                + Text(ClockFormat.time(departure.bestTime))
                    .foregroundStyle(palette.fgTertiary)
        }

        return line.font(FontFamily.ui(density.metaSize, .regular))
    }

    private var separator: Text {
        Text(" · ").foregroundStyle(palette.fgTertiary.opacity(0.45))
    }
}
