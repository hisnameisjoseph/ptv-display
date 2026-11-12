//
//  BoardClient.swift
//  The only thing in the app that talks to the network.
//
//  It talks to the Cloudflare Worker, never to PTV. The Worker holds the
//  credentials, signs the requests, caches per stop and merges the paired
//  stations - so this client is a thin, credential-free JSON reader, and the
//  app can be shipped without embedding a secret.
//

import Foundation

enum BoardClientError: LocalizedError {
    case badURL
    case http(Int)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badURL:            return "Could not build the request."
        case .http(let code):    return "The server returned HTTP \(code)."
        case .decoding(let e):   return "Unexpected response. \(e.localizedDescription)"
        case .transport(let e):  return e.localizedDescription
        }
    }
}

actor BoardClient {

    /// The deployed Worker. Set once, here.
    ///
    /// NOTE: fill this in before first run - it is deliberately left as a
    /// placeholder rather than guessed, because pointing the app at the wrong
    /// host fails in a way that looks like a bug in the app.
    static let defaultBaseURL = URL(string: "https://REPLACE-ME.workers.dev")!

    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL = BoardClient.defaultBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session

        let d = JSONDecoder()
        // The Worker emits ISO-8601 with fractional seconds on some fields and
        // without on others, so accept both rather than failing the whole board
        // on one timestamp.
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.withFractional.date(from: raw) { return date }
            if let date = ISO8601DateFormatter.plain.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "Not an ISO-8601 date: \(raw)"))
        }
        self.decoder = d
    }

    // MARK: - Endpoints

    /// Departures for an ordered list of cards. One request for the whole
    /// board; the Worker fans out and caches each stop independently.
    func board(for cards: [Card]) async throws -> BoardPayload {
        let stops = cards.map(\.stopKey).joined(separator: ",")
        return try await get("/api/board", query: ["stops": stops])
    }

    /// The unified picker: stations and bus stops in one ranked list.
    func search(_ term: String) async throws -> [SearchHit] {
        try await get("/api/search", query: ["q": term])
    }

    /// Every metro station, pre-merged. Small enough to fetch once and filter
    /// on the device, which is why the train picker has no debounce.
    func stations() async throws -> [StationEntry] {
        try await get("/api/stations", query: [:])
    }

    /// Bus stops matching a term. Ranked server-side; the client does not sort.
    func busStops(_ term: String) async throws -> [BusStopHit] {
        try await get("/api/stops/search", query: ["q": term])
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String, query: [String: String]) async throws -> T {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { throw BoardClientError.badURL }

        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw BoardClientError.badURL }

        var request = URLRequest(url: url)
        // The board response is already no-store at the Worker; saying so here
        // stops URLSession serving a stale board after the app is backgrounded.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BoardClientError.transport(error)
        }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw BoardClientError.http(http.statusCode)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw BoardClientError.decoding(error)
        }
    }
}

private extension ISO8601DateFormatter {
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
