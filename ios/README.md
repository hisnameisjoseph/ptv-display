# PTVBoard — iOS

A native SwiftUI client for the same Cloudflare Worker the web board uses.
No credentials live in the app: the Worker signs the PTV requests, caches per
stop, and merges the paired stations, so this is a credential-free JSON reader.

Branch: `feat/ios-app`, cut from `main` at `34938ba`.

---

## Status

| Phase | Contents | State |
|---|---|---|
| **A** | Models, domain logic, API client, design system, board + rows + edit bar | **written, uncompiled** |
| B | Stop pickers (add / change), settings sheet, undo wiring | not started |
| C | Landscape grid, page cycling, overflow trimming | not started |
| D | Home Screen + Lock Screen widgets, Live Activity | not started, see *Widgets* below |

**Nothing here has been compiled.** It was written by reading the TypeScript it
ports and cannot be built in the environment it was written in. Expect to fix
compile errors on first build — mostly `Text` concatenation and `ForEach`
identity, which is where SwiftUI is fussiest.

---

## Getting it into Xcode

The repo carries **source files only** — no `.xcodeproj`. A project file is a
generated artefact that merge-conflicts badly, and hand-writing one is worse
than the five minutes this takes:

1. Xcode → **File → New → Project → iOS → App**
2. Product Name `PTVBoard`, Interface **SwiftUI**, Language **Swift**
3. Save it *outside* this repo, or add `ios/*.xcodeproj` to `.gitignore`
4. Delete the generated `ContentView.swift` and the generated `App.swift`
5. Drag `ios/PTVBoard/` into the project — **Create groups**, *not* folder
   references, and tick "Copy items if needed" only if you want a detached copy
6. Set the deployment target to **iOS 17.0**

   Not 16.1. `DepartureRow` concatenates `Text` values and calls
   `.foregroundStyle()` on them; that overload returns a concatenable `Text`
   only from iOS 17. Live Activities need 16.1+, so 17.0 still clears them.

### Typechecking without a project

The whole tree can be typechecked against the iOS SDK before a project exists,
which is far faster than reading Xcode's errors one file at a time:

```bash
xcrun --sdk iphoneos swiftc -typecheck \
  -target arm64-apple-ios17.0 \
  -swift-version 5 \
  $(find ios/PTVBoard -name '*.swift')
```

**Pin `-swift-version`, or the check is weaker than the build.** Without it
swiftc defaults to Swift 5 while Xcode 16 defaults new projects to Swift 6, so
the command comes back clean on code Xcode refuses.

## Swift language mode

The project must be set to **Swift 5** (project → Build Settings → *Swift
Language Version*).

`BoardStore` is a `@MainActor` class conforming to `ObservableObject`. Under
Swift 6 the synthesised `objectWillChange` inherits the class's actor
isolation, but the protocol requires it to be `nonisolated`, so the conformance
fails and every `BoardStore()` is an error.

The real fix is the Observation framework - `@Observable` instead of
`ObservableObject`, `@State` instead of `@StateObject`, `@Environment(BoardStore.self)`
instead of `@EnvironmentObject`. It needs iOS 17, which is already the target.
That migration is queued for phase B, after which the project can go back to
Swift 6.

### Before first run

`ios/PTVBoard/Net/BoardClient.swift` has a placeholder:

```swift
static let defaultBaseURL = URL(string: "https://REPLACE-ME.workers.dev")!
```

Put your deployed Worker URL there. It is deliberately not guessed — pointing
the app at the wrong host fails in a way that looks like a bug in the app.

### Fonts

`Typography.swift` asks for **Public Sans** and **Inter**, the two faces the web
board uses. Either:

- add the `.ttf` files to the target and list them under `UIAppFonts` in
  `Info.plist`, or
- leave them out — `Font.custom` falls back to the system font at the same
  size, so the layout is right and only the letterforms differ

---

## Free developer account

You said Xcode with a free account, which is enough for phases A–C but bites in
phase D:

- **7-day expiry.** A free provisioning profile dies after a week; the app stops
  launching and has to be re-installed from Xcode.
- **Three App IDs per week.** A widget extension is a second App ID, and a Live
  Activity does not add a third — but you will hit the limit if you experiment.
- **App Groups need a paid account.** This is the one that changes the design.
  Normally a widget reads the app's saved board through a shared container; a
  free account cannot create one.

**The workaround, which is arguably better anyway:** make the widget
*configurable*. The user picks a stop in the widget's own edit sheet
(`AppIntentConfiguration`), WidgetKit stores that choice itself, and the widget
fetches from the Worker directly. No App Group, no shared state.

The cost: the widget does not automatically mirror the board in the app — you
choose its stop separately. Worth knowing before phase D starts.

---

## Architecture

```
App/          entry point
Model/        DTOs, the card model, and the ported domain rules
Net/          the only thing that touches the network
Design/       tokens, type scale, density tiers
Store/        BoardStore - all mutable state, one observable object
Views/        SwiftUI
```

### What was ported, and why it matters

| Swift | From | Why it is not trivial |
|---|---|---|
| `SplitConfig.swift` | `STATION_TYPE_SPLIT` | PTV gives a direction *name*, not a citybound flag. Each station type carries its own rule for sorting departures into two readable groups. |
| `Density.swift` | `densityFor` + the tier blocks | Density is per **card**, not per screen. Two cards side by side can be different tiers. |
| `Formatting.swift` | `countdownParts`, `cardTitle` | Past an hour the countdown switches to `4h / 39 m`, because a third digit overflows the rail. |
| `LineColour.swift` | `LINE_COLORS` | Data, not decoration — it is how you tell a Hurstbridge train from a Mernda one. |
| `Theme.swift` | the three `:root` blocks | Amber on white is ~1.9:1. The *inks* darken in light mode; the badges do not. |

### Rules worth not breaking

- **Type stops shrinking at 17pt.** Below that the board sheds information
  rather than making it smaller. `glance` carries the same type as `compact`;
  what it drops is the metadata line.
- **Every size is one of nine roles.** The web app has a check that walks every
  text node and asserts it. Keep the discipline here.
- **One radius ladder:** 6 / 14 / 16 / 20 / 28 / 36 / pill.
- **Two gutters:** 20 at the root, 16 inside a card.
- **The rail is shared per card.** `RailWidth.needed` sizes it from the widest
  countdown on that card, so a daytime board keeps the narrow rail.
- **Cards have no border.** A fill separates them; the hairline is only ever a
  divider, and it is inset past the rail.

---

## Known gaps in phase A

Placed deliberately, not overlooked:

- Tapping a card header does nothing (picker is phase B)
- The gear in the edit bar does nothing (settings sheet is phase B)
- "Add stop" does nothing (add sheet is phase B)
- Landscape renders the portrait list, not the grid (phase C)
- `StopCard` does not trim rows to fit a fixed-height cell — the landscape
  board needs that, portrait does not
- `DensityTier` is measured from a `GeometryReader` preference, which settles
  one frame after first paint. Expect a brief flash at the wrong tier on
  launch; the web app has the same behaviour for the same reason.
