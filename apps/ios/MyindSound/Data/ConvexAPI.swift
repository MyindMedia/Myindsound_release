import Combine
import ConvexMobile
import Foundation

/// `MyindAPI` on the Convex deployment. Every call carries the Clerk "convex" JWT through
/// `ConvexClientWithAuth` (AUTH-1); the server reads the caller from `ctx.auth` and never from arguments.
///
/// Numbers are passed as `Double`: convex-swift encodes a Swift `Int` as an int64 (`$integer`), which a
/// `v.number()` validator rejects.
final class ConvexAPI: MyindAPI {
    private let client: ConvexClient
    private let queryTimeout: TimeInterval = 20

    init(client: ConvexClient) {
        self.client = client
    }

    // MARK: Queries

    func library() async throws -> LibrarySnapshot {
        APIDecoding.library(try await query(ConvexFunction.library))
    }

    func context(slug: String) async throws -> ReleaseContext {
        APIDecoding.context(try await query(ConvexFunction.context, ["slug": slug]), slug: slug)
    }

    func tracks(slug: String) async throws -> [Track] {
        try APIDecoding.tracks(try await query(ConvexFunction.tracks, ["slug": slug]))
    }

    func leaderboard(slug: String, limit: Int) async throws -> Leaderboard {
        APIDecoding.leaderboard(try await query(ConvexFunction.leaderboard, ["slug": slug, "limit": Double(limit)]), slug: slug)
    }

    func myAwards() async throws -> AwardsSummary {
        APIDecoding.awards(try await query(ConvexFunction.myAwards))
    }

    func exportMyData() async throws -> Data {
        let value: JSONValue = try await query(ConvexFunction.exportMyData)
        return try JSONSerialization.data(withJSONObject: value.foundationObject, options: [.prettyPrinted, .sortedKeys])
    }

    // MARK: Actions and mutations

    func streamURL(trackId: String, lendId: String?) async throws -> StreamURL {
        var args: [String: ConvexEncodable?] = ["trackId": trackId]
        if let lendId { args["lendId"] = lendId }
        let value: JSONValue = try await call { try await self.client.action(ConvexFunction.streamURL, with: args) }
        return try APIDecoding.streamURL(value)
    }

    func recordPlayEvents(_ events: [PlayEvent]) async throws -> [PlayEventResult] {
        guard !events.isEmpty else { return [] }
        let rows: [ConvexEncodable?] = events.map { event in
            var row: [String: ConvexEncodable?] = [
                "idempotencyKey": event.idempotencyKey,
                "slug": event.slug,
                "trackId": event.trackId,
                "startedAtClient": event.startedAtClient,
                "playedSec": event.playedSec,
                "kind": event.kind.rawValue,
            ]
            if let lendId = event.lendId { row["lendId"] = lendId }
            return row
        }
        let value: JSONValue = try await call { try await self.client.mutation(ConvexFunction.recordPlayEvents, with: ["events": rows]) }
        return APIDecoding.playEventResults(value)
    }

    func markUnwrapped(slug: String) async throws {
        let _: JSONValue = try await call { try await self.client.mutation(ConvexFunction.markUnwrapped, with: ["slug": slug]) }
    }

    func recordCartridgeEvent(slug: String, kind: CartridgeEventKind, idempotencyKey: String) async throws {
        let _: JSONValue = try await call {
            try await self.client.mutation(
                ConvexFunction.recordCartridgeEvent,
                with: ["slug": slug, "kind": kind.rawValue, "idempotencyKey": idempotencyKey]
            )
        }
    }

    func registerPushToken(_ token: String, wantsDropAlerts: Bool, sandbox: Bool) async throws {
        let _: JSONValue = try await call {
            try await self.client.mutation(
                ConvexFunction.registerPushToken,
                with: [
                    "token": token,
                    "platform": "ios",
                    "wantsDropAlerts": wantsDropAlerts,
                    "environment": sandbox ? "sandbox" : "production",
                ]
            )
        }
    }

    func unregisterPushToken(_ token: String) async throws {
        let _: JSONValue = try await call { try await self.client.mutation(ConvexFunction.unregisterPushToken, with: ["token": token]) }
    }

    func deleteMyData() async throws {
        let _: JSONValue = try await call { try await self.client.action(ConvexFunction.deleteMyData, with: ["confirm": "DELETE"]) }
    }

    // MARK: Plumbing

    /// One value from a query subscription (the subscription is cancelled once it arrives).
    private func query(_ name: String, _ args: [String: ConvexEncodable?]? = nil) async throws -> JSONValue {
        let publisher = client.subscribe(to: name, with: args, yielding: JSONValue.self)
            .first()
            .timeout(.seconds(queryTimeout), scheduler: DispatchQueue.global(), customError: {
                ClientError.InternalError(msg: "timeout")
            })
        do {
            for try await value in publisher.values { return value }
            throw APIError(code: "EMPTY", message: "No response from the server.")
        } catch let error as ClientError {
            throw Self.map(error)
        }
    }

    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as ClientError {
            throw Self.map(error)
        }
    }

    static func map(_ error: ClientError) -> APIError {
        switch error {
        case .ConvexError(let data): return APIDecoding.error(convexErrorData: data)
        case .ServerError(let message): return APIDecoding.error(serverMessage: message)
        case .InternalError(let message):
            return message == "timeout"
                ? APIError(code: "OFFLINE", message: "Can't reach Myind Sound. Check your connection.")
                : APIError(code: "INTERNAL", message: "Something went wrong. Try again.")
        }
    }
}

extension JSONValue {
    /// Back to Foundation types, for `JSONSerialization` (the privacy export file).
    var foundationObject: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number: return double ?? 0
        case .string(let value): return value
        case .array(let values): return values.map(\.foundationObject)
        case .object(let object):
            if object["$integer"] != nil || object["$float"] != nil { return double ?? 0 }
            return object.mapValues(\.foundationObject)
        }
    }
}
