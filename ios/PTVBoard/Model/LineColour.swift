//
//  LineColour.swift
//  Metro line liveries, ported from LINE_COLORS in src/frontend/app.ts.
//
//  These are data, not decoration: the badge is how you tell a Hurstbridge
//  train from a Mernda one at a glance. They are therefore identical in both
//  themes - a filled chip carries its own background and is legible on any
//  surface.
//

import SwiftUI

struct LineLivery {
    let background: Color
    let ink: Color
}

enum LineColours {
    /// Longest match wins, so "Glen Waverley" is not shadowed by a shorter key.
    private static let table: [(name: String, livery: LineLivery)] = [
        ("Alamein",       LineLivery(background: .hex(0x152C6B), ink: .white)),
        ("Belgrave",      LineLivery(background: .hex(0x152C6B), ink: .white)),
        ("Craigieburn",   LineLivery(background: .hex(0xFFBE00), ink: .hex(0x111111))),
        ("Cranbourne",    LineLivery(background: .hex(0x279FD5), ink: .white)),
        ("Flemington",    LineLivery(background: .hex(0x95979A), ink: .hex(0x111111))),
        ("Frankston",     LineLivery(background: .hex(0x028430), ink: .white)),
        ("Glen Waverley", LineLivery(background: .hex(0x152C6B), ink: .white)),
        ("Hurstbridge",   LineLivery(background: .hex(0xBE1014), ink: .white)),
        ("Lilydale",      LineLivery(background: .hex(0x152C6B), ink: .white)),
        ("Mernda",        LineLivery(background: .hex(0xBE1014), ink: .white)),
        ("Pakenham",      LineLivery(background: .hex(0x279FD5), ink: .white)),
        ("Sandringham",   LineLivery(background: .hex(0xF178AF), ink: .hex(0x111111))),
        ("Stony Point",   LineLivery(background: .hex(0x028430), ink: .white)),
        ("Sunbury",       LineLivery(background: .hex(0x279FD5), ink: .white)),
        ("Upfield",       LineLivery(background: .hex(0xFFBE00), ink: .hex(0x111111))),
        ("Werribee",      LineLivery(background: .hex(0xF178AF), ink: .hex(0x111111))),
        ("Williamstown",  LineLivery(background: .hex(0xF178AF), ink: .hex(0x111111))),
    ]

    /// nil for a route with no known livery - a bus, or a line PTV has renamed.
    /// The caller falls back to the generic mode colour.
    static func livery(for routeName: String) -> LineLivery? {
        let name = routeName.lowercased()
        guard !name.isEmpty else { return nil }
        return table.first { name.contains($0.name.lowercased()) }?.livery
    }
}

extension Color {
    /// 0xRRGGBB, so the table above reads like the CSS it came from.
    static func hex(_ value: UInt32) -> Color {
        Color(
            .sRGB,
            red:   Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue:  Double(value & 0xFF) / 255,
            opacity: 1)
    }
}
