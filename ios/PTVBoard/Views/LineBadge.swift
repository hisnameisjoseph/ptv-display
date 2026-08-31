//
//  LineBadge.swift
//  The coloured chip that says which service this is.
//
//  A filled chip carrying its own background, which is why it is identical in
//  both themes: it is legible on any surface. Trains get the line's livery and
//  its initial; buses get the route number on the generic bus orange.
//

import SwiftUI

struct LineBadge: View {
    let route: String
    let mode: CardMode

    @Environment(\.palette) private var palette
    @Environment(\.density) private var density

    private var livery: LineLivery {
        if mode == .train, let known = LineColours.livery(for: route) { return known }
        return LineLivery(background: mode == .train ? Brand.train : Brand.bus, ink: .white)
    }

    /// A train shows the line's initial; a bus shows its whole route number,
    /// because "8" and "82" are different buses.
    private var text: String {
        mode == .train ? String(route.prefix(1)) : route
    }

    var body: some View {
        Text(text)
            .font(FontFamily.display(density.badgeSize, .bold))
            .foregroundStyle(livery.ink)
            .padding(.horizontal, 5)
            .padding(.vertical, 4)
            .frame(minWidth: 20)
            .background(livery.background, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
                    .strokeBorder(palette.badgeEdge, lineWidth: 1))
            .fixedSize()
    }
}
