//
//  Theme.swift
//  The token ladders, ported from the three :root blocks in public/styles.css.
//
//  The split between them is the whole design:
//
//    Brand      identical in both themes
//    Surfaces   a four-step tint ladder, inverted for light
//    Ink        the coloured text, which has to darken on a light surface
//
//  A departure looks the same in both themes. Line badges are filled chips
//  carrying their own background, so they never move. What moves is the
//  surfaces behind them, the greys, and the three coloured inks - because
//  #ffb300 text on white is about 1.9:1 and cannot be read.
//

import SwiftUI

enum ThemeChoice: String, CaseIterable {
    case dark
    case light

    var colorScheme: ColorScheme { self == .dark ? .dark : .light }
    var next: ThemeChoice { self == .dark ? .light : .dark }

    /// The button shows where it will take you, not where you are.
    var toggleSymbol: String { self == .dark ? "sun.max.fill" : "moon.fill" }
    var toggleLabel: String {
        self == .dark ? "Switch to light mode" : "Switch to dark mode"
    }
}

/// Brand and status. Identical in both themes.
enum Brand {
    static let amber = Color.hex(0xFFB300)
    static let live  = Color.hex(0x37C978)
    static let train = Color.hex(0x2A6FB8)
    static let bus   = Color.hex(0xE07020)
    static let late  = Color.hex(0xEA4D3C)
}

/// Every surface and ink, resolved for one theme.
struct Palette {
    // Surfaces
    let bg: Color
    let bgRaised: Color
    let bgSunken: Color
    let bgBand: Color
    let selected: Color
    let hairline: Color

    // Text
    let fg: Color
    let fgSecondary: Color
    let fgTertiary: Color
    let fgPlaceholder: Color

    // Coloured ink
    let inkCount: Color
    let inkLive: Color
    let inkLate: Color
    let onAccent: Color

    // Chrome
    let scrim: Color
    let sheetShadow: Color
    let editingCard: Color
    /// Transparent in dark. In light a bright badge - Craigieburn amber,
    /// Upfield yellow - would otherwise dissolve into a white card.
    let badgeEdge: Color

    static let dark = Palette(
        bg:            .hex(0x000000),
        bgRaised:      .hex(0x121212),
        bgSunken:      .hex(0x0A0A0A),
        bgBand:        .hex(0x181818),
        selected:      .hex(0x242424),
        hairline:      .hex(0x232323),
        fg:            .hex(0xFFFFFF),
        fgSecondary:   .hex(0x8B8B8B),
        fgTertiary:    .hex(0x8A8A8A),
        fgPlaceholder: .hex(0x5A5A5A),
        inkCount:      Brand.amber,
        inkLive:       Brand.live,
        inkLate:       Brand.late,
        onAccent:      .hex(0x000000),
        scrim:         Color.black.opacity(0.6),
        sheetShadow:   Color.black.opacity(0.6),
        editingCard:   .hex(0x161616),
        badgeEdge:     .clear)

    static let light = Palette(
        bg:            .hex(0xFFFFFF),
        bgRaised:      .hex(0xF6F6F6),
        bgSunken:      .hex(0xECECEC),
        bgBand:        .hex(0xEFEFEF),
        selected:      .hex(0xE2E2E2),
        hairline:      .hex(0xE4E4E4),
        fg:            .hex(0x000000),
        fgSecondary:   .hex(0x6B6B6B),
        fgTertiary:    .hex(0x6F6F6F),
        fgPlaceholder: .hex(0xA6A6A6),
        // Same hue families, dark enough to read on a light surface.
        // Bright amber on white is ~1.9:1; this is ~5.4:1.
        inkCount:      .hex(0xA05E00),
        inkLive:       .hex(0x0F7A44),
        inkLate:       .hex(0xC8341F),
        onAccent:      .hex(0x000000),
        scrim:         Color.black.opacity(0.32),
        sheetShadow:   Color.black.opacity(0.18),
        editingCard:   .hex(0xEEEEEE),
        badgeEdge:     Color.black.opacity(0.12))

    static func of(_ choice: ThemeChoice) -> Palette {
        choice == .dark ? .dark : .light
    }
}

// MARK: - Radius and spacing

/// One ladder, nothing between the rungs.
enum Radius {
    static let sm: CGFloat = 6      // line badge
    static let md: CGFloat = 14     // input
    static let lg: CGFloat = 16     // banner
    static let xl: CGFloat = 20     // card
    static let xxl: CGFloat = 28
    static let sheet: CGFloat = 36
    /// "Pill" - anything interactive and inline.
    static let full: CGFloat = 999
}

/// 4px grid. Two gutters only: 20 at the root, 16 inside a card.
enum Space {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32

    static let rootGutter: CGFloat = 20
    static let cardGutter: CGFloat = 16
}

// MARK: - Environment

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.dark
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
