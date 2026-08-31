//
//  BoardView.swift
//  The board: a title, two controls, and the stop cards.
//
//  Portrait scrolls; landscape is handled by LandscapeBoard in phase C. The
//  header carries no clock and no freshness line - deliberately. A stale board
//  keeps showing its last payload, and every row carries an absolute time as
//  well as a countdown.
//

import SwiftUI

struct BoardView: View {
    @EnvironmentObject private var store: BoardStore
    @Environment(\.scenePhase) private var scenePhase

    private var palette: Palette { Palette.of(store.theme) }

    var body: some View {
        ZStack(alignment: .bottom) {
            palette.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                cards
            }

            if store.pendingUndo != nil { undoToast }
        }
        .environment(\.palette, palette)
        .preferredColorScheme(store.theme.colorScheme)
        .task { store.start() }
        .onChange(of: scenePhase) { phase in
            // A board nobody is looking at should not poll every 45 seconds.
            switch phase {
            case .active:     store.start(); Task { await store.refresh() }
            case .background: store.stop()
            default:          break
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: Space.s3) {
            Text("My Stops")
                .font(TypeRole.title2())
                .kerning(-0.22)
                .foregroundStyle(palette.fg)

            Spacer()

            HStack(spacing: Space.s2) {
                circleButton(store.theme.toggleSymbol,
                             label: store.theme.toggleLabel,
                             active: false) {
                    store.theme = store.theme.next
                }
                circleButton("pencil",
                             label: store.editMode ? "Done editing" : "Edit board",
                             active: store.editMode) {
                    store.editMode.toggle()
                }
            }
        }
        .padding(.horizontal, Space.rootGutter)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s4)
    }

    private func circleButton(_ symbol: String,
                              label: String,
                              active: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(active ? palette.onAccent : palette.fgSecondary)
                .frame(width: 44, height: 44)
                .background(active ? Brand.amber : palette.bgRaised, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - Cards

    private var cards: some View {
        ScrollView {
            LazyVStack(spacing: Space.s3) {
                ForEach(Array(store.cards.enumerated()), id: \.element.id) { index, card in
                    StopCard(card: card, index: index, isGrid: false)
                }
                if store.editMode { addTile }
            }
            .padding(.horizontal, Space.rootGutter)
            .padding(.bottom, Space.s6)
        }
        .scrollIndicators(.hidden)
    }

    private var addTile: some View {
        let full = store.cards.count >= BoardRules.maxCards
        return VStack(spacing: 6) {
            Button {
                // Add sheet - phase B.
            } label: {
                HStack(spacing: Space.s2) {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(full ? palette.fgPlaceholder : palette.inkCount)
                    Text(full ? "Limit of \(BoardRules.maxCards) stops" : "Add stop")
                        .font(TypeRole.headline())
                        .foregroundStyle(full ? palette.fgPlaceholder : palette.fg)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(full)

            if !full && store.cards.count >= BoardRules.warnFrom {
                Text("Cards are getting tight at this many stops.")
                    .font(TypeRole.footnote())
                    .foregroundStyle(palette.fgSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(Space.s3)
        .frame(maxWidth: .infinity)
        .background(palette.bgRaised,
                    in: RoundedRectangle(cornerRadius: Radius.xl, style: .continuous))
    }

    // MARK: - Undo

    private var undoToast: some View {
        HStack(spacing: Space.s4) {
            Text("Stop removed")
                .font(TypeRole.subheadline)
                .foregroundStyle(palette.fg)
            Button("Undo") { store.undoRemove() }
                .font(FontFamily.ui(15, .bold))
                .foregroundStyle(palette.inkCount)
                .buttonStyle(.plain)
        }
        .padding(.horizontal, Space.s5)
        .frame(minHeight: 44)
        .background(palette.selected, in: Capsule())
        .shadow(color: palette.sheetShadow, radius: 14, y: 8)
        .padding(.bottom, Space.s3)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: store.pendingUndo?.card.id)
    }
}
