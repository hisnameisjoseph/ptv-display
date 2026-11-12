//
//  Typography.swift
//  Nine roles, and nothing else.
//
//  Ported from the type scale in public/styles.css. The web app is verified
//  against this list - a sweep walks every rendered text node and asserts its
//  size is one of these - so the same discipline is worth keeping here.
//
//  Two families, matching the web app: Public Sans for anything numeric or
//  name-like, Inter for labels and prose. Both ship in the app bundle; if a
//  face is missing, the system font stands in at the same size rather than
//  the layout collapsing.
//

import SwiftUI

enum FontFamily {
    /// Badge, destination, countdown, card titles.
    static let display = "PublicSans"
    /// Metadata, units, labels, sheets.
    static let ui = "Inter"

    static func display(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        .custom(display, size: size).weight(weight)
    }

    static func ui(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        .custom(ui, size: size).weight(weight)
    }
}

/// The nine roles. Sizes are fixed on purpose: density steps DOWN a rung
/// rather than inventing an intermediate size, and nothing shrinks below 17.
enum TypeRole {
    /// 34 / 700 - the countdown numeral at comfortable density.
    static func display(_ size: CGFloat = 34) -> Font { FontFamily.display(size, .bold) }
    /// 34 / 700 - a screen title.
    static var largeTitle: Font { FontFamily.ui(34, .bold) }
    /// 22 / 700 - destination, board title, sheet title.
    static func title2(_ size: CGFloat = 22) -> Font { FontFamily.display(size, .bold) }
    /// 17 / 600 - card header, picker result.
    static func headline(_ size: CGFloat = 17) -> Font { FontFamily.display(size, .semibold) }
    /// 17 / 400 - prose.
    static var body: Font { FontFamily.ui(17, .regular) }
    /// 15 / 400
    static var subheadline: Font { FontFamily.ui(15, .regular) }
    /// 13 / 400 - row metadata.
    static func footnote(_ size: CGFloat = 13) -> Font { FontFamily.ui(size, .regular) }
    /// 12 / 600 / +0.6 tracking / caps - direction bands, units, eyebrows.
    static func overline(_ size: CGFloat = 12) -> Font { FontFamily.ui(size, .semibold) }
    /// 11 / 500 - compact units.
    static func caption(_ size: CGFloat = 11) -> Font { FontFamily.ui(size, .medium) }
}

/// An overline is a role, not just a size: uppercase with positive tracking.
struct OverlineStyle: ViewModifier {
    let size: CGFloat
    let tracking: CGFloat
    let colour: Color

    func body(content: Content) -> some View {
        content
            .font(TypeRole.overline(size))
            .tracking(tracking)
            .textCase(.uppercase)
            .foregroundStyle(colour)
    }
}

extension View {
    func overline(size: CGFloat = 12, tracking: CGFloat = 0.6, colour: Color) -> some View {
        modifier(OverlineStyle(size: size, tracking: tracking, colour: colour))
    }
}
