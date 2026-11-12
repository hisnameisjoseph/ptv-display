//
//  Density.swift
//  How much a card shows is a function of how big that card actually is.
//
//  Not a size class, and not the device orientation: two cards side by side on
//  the same screen can be different tiers. On the web this is a ResizeObserver
//  writing data-density onto each card; here it is a GeometryReader handing a
//  measured size to DensityTier.forCard.
//
//  The rule that matters: type stops shrinking at 17pt. Below that the board
//  sheds information rather than making it smaller, because a departure you
//  cannot read is worth nothing.
//

import SwiftUI

enum DensityTier {
    case comfortable
    case compact
    /// The fallback: anything narrower than 260 or shorter than 200.
    case glance

    static let comfortableMin = CGSize(width: 620, height: 340)
    static let compactMin = CGSize(width: 260, height: 200)

    /// Both dimensions have to pass. A card 900 wide but 180 tall is glance,
    /// because height is what rows consume.
    static func forCard(_ size: CGSize) -> DensityTier {
        if size.width >= comfortableMin.width && size.height >= comfortableMin.height {
            return .comfortable
        }
        if size.width >= compactMin.width && size.height >= compactMin.height {
            return .compact
        }
        return .glance
    }

    /// Below this width a two-column direction split gets too cramped to read,
    /// so the columns stack instead. Calibrated on the web against the point
    /// where a long destination starts to ellipsize.
    static let splitMinWidth: CGFloat = 460
}

/// The measurements a tier hands to the views. Compact and glance carry the
/// SAME type sizes - glance is not "compact but smaller". What glance does is
/// drop the metadata line and set its unit beside the numeral instead of under
/// it, which is where the height for a second direction comes from.
struct DensityMetrics {
    let nameSize: CGFloat
    let nameLine: CGFloat
    let minsSize: CGFloat
    let unitSize: CGFloat
    let unitTracking: CGFloat
    let metaSize: CGFloat
    let badgeSize: CGFloat
    let railWidth: CGFloat
    let rowPadV: CGFloat
    let rowPadH: CGFloat
    let rowGap: CGFloat
    let headerSize: CGFloat
    let bandSize: CGFloat
    /// Glance sheds it entirely.
    let showsMetadata: Bool
    /// Glance sets the unit beside the numeral rather than beneath it.
    let inlineUnit: Bool

    static let comfortable = DensityMetrics(
        nameSize: 22, nameLine: 28,
        minsSize: 34,
        unitSize: 12, unitTracking: 0.6,
        metaSize: 13,
        badgeSize: 12,
        railWidth: 56,
        rowPadV: 12, rowPadH: 16, rowGap: 12,
        headerSize: 17, bandSize: 12,
        showsMetadata: true, inlineUnit: false)

    /// One rung down: headline destination, title-2 countdown.
    static let compact = DensityMetrics(
        nameSize: 17, nameLine: 22,
        minsSize: 22,
        unitSize: 11, unitTracking: 0.4,
        metaSize: 13,
        badgeSize: 11,
        // A rail only has to hold the widest countdown the card is showing;
        // RailWidth below grows it when an hour-scale time appears.
        railWidth: 36,
        // A split column is 237pt at phone-landscape sizes and a destination
        // like "Flinders Street" needs 141 of them. Measured, not chosen: at
        // 12 it was 4pt short and ellipsized every city-bound row.
        rowPadV: 10, rowPadH: 8, rowGap: 12,
        headerSize: 17, bandSize: 11,
        showsMetadata: true, inlineUnit: false)

    static let glance = DensityMetrics(
        nameSize: 17, nameLine: 22,
        minsSize: 22,
        unitSize: 11, unitTracking: 0.4,
        metaSize: 13,
        badgeSize: 11,
        // Wider than compact, not narrower: the unit sits beside the numeral.
        railWidth: 62,
        rowPadV: 7, rowPadH: 12, rowGap: 12,
        headerSize: 17, bandSize: 11,
        showsMetadata: false, inlineUnit: true)

    static func of(_ tier: DensityTier) -> DensityMetrics {
        switch tier {
        case .comfortable: return .comfortable
        case .compact:     return .compact
        case .glance:      return .glance
        }
    }
}

/// The rail is one column shared by every row in a card, so it has to be as
/// wide as the widest countdown that card is showing. A daytime board is all
/// two-digit minutes and keeps the narrow rail, giving the width to the
/// destination; only a card carrying hour-scale times pays for a wider one.
enum RailWidth {
    static func needed(for departures: [Departure],
                       metrics: DensityMetrics,
                       now: Date = Date()) -> CGFloat {
        var widest = metrics.railWidth
        for dep in departures {
            let mins = Countdown.minutesUntil(dep.bestTime, now: now)
            let parts = Countdown.parts(minutes: mins)
            // Public Sans tabular digits run about 0.62em; the unit is smaller
            // and tracked. Estimating rather than measuring keeps this cheap
            // enough to run on every render.
            let numeral = CGFloat(parts.value.count) * metrics.minsSize * 0.62
            let unit = CGFloat(parts.unit.count) * metrics.unitSize * 0.58
            let need = metrics.inlineUnit
                ? numeral + Space.s1 + unit   // side by side
                : max(numeral, unit)          // stacked
            widest = max(widest, need.rounded(.up))
        }
        return widest
    }
}

private struct DensityKey: EnvironmentKey {
    static let defaultValue = DensityMetrics.comfortable
}

extension EnvironmentValues {
    var density: DensityMetrics {
        get { self[DensityKey.self] }
        set { self[DensityKey.self] = newValue }
    }
}
