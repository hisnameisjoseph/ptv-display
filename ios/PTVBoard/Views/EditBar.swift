//
//  EditBar.swift
//  The per-card controls, shown only while the board is being edited.
//
//  Outside edit mode the board carries no chrome at all, which is what makes
//  it safe to leave on a screen. The bar keeps a fixed height and the buttons
//  fill it edge to edge, so a large glyph and a full-width hit target cost no
//  extra height.
//

import SwiftUI

struct EditBar: View {
    let card: Card
    let index: Int

    @EnvironmentObject private var store: BoardStore
    @Environment(\.palette) private var palette

    /// Matches the web app's bar height exactly.
    private let barHeight: CGFloat = 41

    var body: some View {
        HStack(spacing: Space.s1) {
            button("arrow.up", "Move up", enabled: index > 0) {
                store.move(from: index, by: -1)
            }
            button("arrow.down", "Move down", enabled: index < store.cards.count - 1) {
                store.move(from: index, by: +1)
            }
            button(card.primary == true ? "star.fill" : "star",
                   card.primary == true ? "Primary stop" : "Make primary",
                   enabled: card.primary != true,
                   tint: card.primary == true ? palette.inkCount : nil) {
                store.setPrimary(card)
            }
            button("gearshape", "Stop settings", enabled: true) {
                // Settings sheet - phase B.
            }

            Spacer(minLength: 0)

            button("xmark", "Remove stop",
                   enabled: store.cards.count > 1,
                   tint: palette.inkLate) {
                store.remove(card)
            }
        }
        .padding(.horizontal, Space.s2)
        .frame(height: barHeight)
        .background(palette.bgBand)
    }

    private func button(_ symbol: String,
                        _ label: String,
                        enabled: Bool,
                        tint: Color? = nil,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(enabled ? (tint ?? palette.fg) : palette.fgPlaceholder)
                .frame(width: 44, height: barHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}
