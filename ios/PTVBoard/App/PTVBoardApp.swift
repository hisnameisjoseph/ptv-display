//
//  PTVBoardApp.swift
//  Entry point.
//

import SwiftUI

@main
struct PTVBoardApp: App {
    @StateObject private var store = BoardStore()

    var body: some Scene {
        WindowGroup {
            BoardView()
                .environmentObject(store)
        }
    }
}
