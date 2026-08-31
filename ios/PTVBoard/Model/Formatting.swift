//
//  Formatting.swift
//  The three text rules the board depends on, ported one for one from
//  src/frontend/app.ts so the two clients read identically.
//

import Foundation

enum Countdown {
    /// A countdown, split into what sits on the rail and what sits under it.
    ///
    /// Under an hour it is the plain minute count. Past that the numeral would
    /// need a third digit, which overflows the rail and crowds the edge of the
    /// card - and nobody plans around 279 minutes anyway. The hour takes the
    /// numeral and the remainder becomes the unit; the exact departure time is
    /// on the metadata line either way.
    static func parts(minutes: Int) -> (value: String, unit: String) {
        if minutes < 60 { return (String(minutes), "min") }
        let h = minutes / 60
        let m = minutes % 60
        return ("\(h)h", m == 0 ? "hrs" : "\(m) m")
    }

    /// The same countdown on one line, for a collapsed card's header.
    static func short(minutes: Int) -> String {
        if minutes < 60 { return "\(minutes)m" }
        let h = minutes / 60
        let m = minutes % 60
        return m == 0 ? "\(h)h" : String(format: "%dh%02d", h, m)
    }

    /// Whole minutes from now, rounded the same way the web app rounds.
    static func minutesUntil(_ date: Date, now: Date = Date()) -> Int {
        Int((date.timeIntervalSince(now) / 60).rounded())
    }
}

enum StopName {
    /// Every metro station name ends in "Station", so on a card that is
    /// already unmistakably a train - line-coloured badges, a direction split -
    /// the word carries no information and costs a header line.
    ///
    /// Trailing occurrences only, per slash-separated segment, so a stop
    /// genuinely called "Station Street" is untouched. Display only: the
    /// database, the search results and the payload label all stay full,
    /// because you want certainty when choosing a stop and brevity once it is
    /// on your board.
    static func cardTitle(_ label: String, mode: CardMode) -> String {
        guard mode == .train else { return label }
        return label
            .components(separatedBy: " / ")
            .map { part in
                let trimmed = part.replacingOccurrences(
                    of: #"\s+Station$"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive])
                // A stop named only "Station" keeps its name.
                return trimmed.isEmpty ? part : trimmed
            }
            .joined(separator: " / ")
    }

    /// "Footscray · 216, 220, 402 +2" - the dimmer second line of a picker row.
    /// Either half may be missing, and both may be.
    static func pickerMeta(suburb: String?, routes: [String]) -> String {
        var parts: [String] = []
        if let suburb, !suburb.isEmpty { parts.append(suburb) }
        if !routes.isEmpty {
            let shown = routes.prefix(BoardRules.busRoutesShown).joined(separator: ", ")
            let extra = routes.count - BoardRules.busRoutesShown
            parts.append(extra > 0 ? "\(shown) +\(extra)" : shown)
        }
        return parts.joined(separator: " · ")
    }
}

enum ClockFormat {
    /// Melbourne, 24 hour, always - the board shows PTV's local timetable and
    /// a phone roaming in another zone must not silently shift it.
    private static let melbourne: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_AU")
        f.timeZone = TimeZone(identifier: "Australia/Melbourne")
        f.dateFormat = "HH:mm"
        return f
    }()

    static func time(_ date: Date) -> String { melbourne.string(from: date) }
}
