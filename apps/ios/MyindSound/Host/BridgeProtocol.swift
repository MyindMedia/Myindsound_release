import Foundation

/// The bridge wire contract v1 on the native side (packages/bridge/CONTRACT.md). Pure: parsing and validating
/// what the page posts (BRG-1), the error codes (§8) and the payload encoders (§5, §6). `NativeBridge` does the
/// work; everything here is unit tested without a web view.
enum BridgeContract {
    /// CONTRACT.md §3: the versions this build speaks. The shim carries the same numbers.
    static let version = 1
    static let minVersion = 1
    /// §4 `READY_TIMEOUT_MS` [DECIDE]: the splash waits this long for `ready()`.
    static let readyTimeout: TimeInterval = 8
    static let scheme = "myind-bundle"
    static let handlerName = "myind"
    static let maxSeekSeconds: Double = 21_600
    static let spectrumBands = 64
    static let waveformSamples = 128
    static let maxFramesPerSecond = 60

    /// Every method in §4, and whether it is a notify (fire and forget, `id: null`).
    enum Method: String, CaseIterable {
        case getContext, getTracks, play, pause, seek, next, previous, getPlaybackState, setVolume
        case markUnwrapped, cartridgeLoaded, cartridgeEjected, requestShare, requestLend
        case haptic, playSound, close, ready

        var isNotify: Bool {
            switch self {
            case .haptic, .playSound, .close, .ready: return true
            default: return false
            }
        }
    }

    enum HapticKind: String, CaseIterable { case light, medium, heavy, rigid, soft, success }

    /// A validated request, with clean params.
    enum Call: Equatable {
        case getContext, getTracks, pause, next, previous, getPlaybackState
        case play(trackId: String, startAt: Double?)
        case seek(seconds: Double)
        case setVolume(Double)
        case markUnwrapped, cartridgeLoaded, cartridgeEjected, requestShare, requestLend
        case haptic(HapticKind)
        case playSound(String)
        case close, ready
    }

    /// §8 error codes native raises.
    enum ErrorCode: String {
        case unknownMethod = "E_UNKNOWN_METHOD"
        case invalidParams = "E_INVALID_PARAMS"
        case notAllowed = "E_NOT_ALLOWED"
        case lendEnded = "E_LEND_ENDED"
        case notFound = "E_NOT_FOUND"
        case notSupported = "E_NOT_SUPPORTED"
        case offline = "E_OFFLINE"
        case internalError = "E_INTERNAL"
    }

    struct BridgeError: Error, Equatable {
        var code: ErrorCode
        var message: String

        init(_ code: ErrorCode, _ message: String) {
            self.code = code
            self.message = message
        }

        /// `{ code, message }`, exactly (§5).
        var payload: [String: Any] { ["code": code.rawValue, "message": message] }
    }

    /// What to do with one posted message.
    enum Decision: Equatable {
        /// Run it and resolve `id` (nil for a notify).
        case call(id: String?, Call)
        /// Answer `id` with this error without doing anything.
        case reject(id: String, BridgeError)
        /// Drop without answering (wrong origin, bad id, invalid notify). `reason` is for the log: never
        /// page content beyond a method name.
        case drop(reason: String)
    }

    /// Where a message came from (`WKScriptMessage.frameInfo`), reduced to what §1.1 checks.
    struct Origin: Equatable {
        var isMainFrame: Bool
        var scheme: String
        var host: String
        var port: Int
    }

    private static let idPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{32}$")
    private static let trackIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,128}$")
    private static let soundPattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,63}$")

    static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    static func isValidId(_ value: String) -> Bool { matches(idPattern, value) }
    static func isValidTrackId(_ value: String) -> Bool { matches(trackIdPattern, value) }

    /// §1.1: only the main frame of `myind-bundle://<slug>` for the release this view loaded.
    static func isTrusted(_ origin: Origin, slug: String) -> Bool {
        origin.isMainFrame && origin.scheme == scheme && origin.host == slug && origin.port == 0
    }

    /// §1 and §4 in one place: origin, id, method, params. `seenIds` are ids already used on this page load
    /// (pending or answered); an id is never answered twice.
    static func decide(body: Any, origin: Origin, slug: String, seenIds: Set<String> = []) -> Decision {
        guard isTrusted(origin, slug: slug) else { return .drop(reason: "untrusted origin") }
        guard let message = body as? [String: Any] else { return .drop(reason: "not an object") }

        // The id first: without a valid one nothing can be answered.
        let rawId = message["id"]
        var id: String?
        if let string = rawId as? String {
            guard isValidId(string) else { return .drop(reason: "bad id") }
            guard !seenIds.contains(string) else { return .drop(reason: "reused id") }
            id = string
        } else if rawId == nil || rawId is NSNull {
            id = nil
        } else {
            return .drop(reason: "bad id")
        }

        guard let name = message["method"] as? String, let method = Method(rawValue: name) else {
            if let id { return .reject(id: id, BridgeError(.unknownMethod, "Unknown bridge method")) }
            return .drop(reason: "unknown method")
        }
        if method.isNotify {
            guard id == nil else { return .drop(reason: "\(method.rawValue): notify with an id") }
        } else {
            guard id != nil else { return .drop(reason: "\(method.rawValue): request without an id") }
        }

        let params: [String: Any]
        switch message["params"] {
        case nil: params = [:]
        case let object as [String: Any]: params = object
        default:
            return fail(id, method, "params must be an object")
        }

        switch validate(method, params) {
        case .success(let call): return .call(id: id, call)
        case .failure(let error): return fail(id, method, error.message)
        }
    }

    private static func fail(_ id: String?, _ method: Method, _ message: String) -> Decision {
        guard let id else { return .drop(reason: "\(method.rawValue): invalid params") }
        return .reject(id: id, BridgeError(.invalidParams, "\(method.rawValue): \(message)"))
    }

    /// §4 param rules (the same as `src/validate.ts`).
    static func validate(_ method: Method, _ params: [String: Any]) -> Result<Call, BridgeError> {
        func only(_ allowed: [String]) -> BridgeError? {
            for key in params.keys where !allowed.contains(key) {
                return BridgeError(.invalidParams, "unexpected param \"\(key.prefix(32))\"")
            }
            return nil
        }
        func seconds(_ name: String, _ value: Any?) -> Result<Double, BridgeError> {
            guard let number = finiteNumber(value), number >= 0, number <= maxSeekSeconds else {
                return .failure(BridgeError(.invalidParams, "\(name) must be a finite number from 0 to \(Int(maxSeekSeconds))"))
            }
            return .success(number)
        }

        switch method {
        case .play:
            if let error = only(["trackId", "startAt"]) { return .failure(error) }
            guard let trackId = params["trackId"] as? String, isValidTrackId(trackId) else {
                return .failure(BridgeError(.invalidParams, "trackId must be 1-128 characters of A-Z a-z 0-9 _ -"))
            }
            guard params.keys.contains("startAt") else { return .success(.play(trackId: trackId, startAt: nil)) }
            // Present, startAt may not be null.
            return seconds("startAt", params["startAt"]).map { .play(trackId: trackId, startAt: $0) }
        case .seek:
            if let error = only(["seconds"]) { return .failure(error) }
            return seconds("seconds", params["seconds"]).map { .seek(seconds: $0) }
        case .setVolume:
            if let error = only(["volume"]) { return .failure(error) }
            guard let volume = finiteNumber(params["volume"]), volume >= 0, volume <= 1 else {
                return .failure(BridgeError(.invalidParams, "volume must be a number from 0 to 1"))
            }
            return .success(.setVolume(volume))
        case .haptic:
            if let error = only(["kind"]) { return .failure(error) }
            guard let raw = params["kind"] as? String, let kind = HapticKind(rawValue: raw) else {
                return .failure(BridgeError(.invalidParams, "kind must be one of light, medium, heavy, rigid, soft, success"))
            }
            return .success(.haptic(kind))
        case .playSound:
            if let error = only(["name"]) { return .failure(error) }
            guard let name = params["name"] as? String, matches(soundPattern, name) else {
                return .failure(BridgeError(.invalidParams, "name must be 1-64 characters of a-z 0-9 -"))
            }
            return .success(.playSound(name))
        default:
            if let error = only([]) { return .failure(error) }
            switch method {
            case .getContext: return .success(.getContext)
            case .getTracks: return .success(.getTracks)
            case .pause: return .success(.pause)
            case .next: return .success(.next)
            case .previous: return .success(.previous)
            case .getPlaybackState: return .success(.getPlaybackState)
            case .markUnwrapped: return .success(.markUnwrapped)
            case .cartridgeLoaded: return .success(.cartridgeLoaded)
            case .cartridgeEjected: return .success(.cartridgeEjected)
            case .requestShare: return .success(.requestShare)
            case .requestLend: return .success(.requestLend)
            case .close: return .success(.close)
            case .ready: return .success(.ready)
            case .play, .seek, .setVolume, .haptic, .playSound: fatalError("handled above")
            }
        }
    }

    /// A JS number: finite, and never a boolean (`true` arrives as an NSNumber too).
    static func finiteNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }

    // MARK: Per page secrets (§2)

    /// 32 lowercase hex characters from `SecRandomCopyBytes`.
    static func randomHex(bytes: Int = 16) -> String {
        var buffer = [UInt8](repeating: 0, count: bytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes, &buffer)
        precondition(status == errSecSuccess, "CSPRNG unavailable")
        return buffer.map { String(format: "%02x", $0) }.joined()
    }

    /// The shim with its two placeholders replaced. Nil when the file doesn't have each exactly once.
    static func substituteShim(_ source: String, token: String, channelKey: String) -> String? {
        let tokenMark = "__MYIND_CONNECT_TOKEN__", keyMark = "__MYIND_CHANNEL_KEY__"
        guard source.components(separatedBy: tokenMark).count == 2,
              source.components(separatedBy: keyMark).count == 2,
              token != channelKey, isHex(token), isHex(channelKey) else { return nil }
        return source.replacingOccurrences(of: tokenMark, with: token).replacingOccurrences(of: keyMark, with: channelKey)
    }

    static func isHex(_ value: String) -> Bool {
        value.count >= 32 && value.count <= 128 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// `<meta name="myind-bridge" content="token=<hex>;version=<max>;min=<min>">`.
    static func metaTag(token: String) -> String {
        #"<meta name="myind-bridge" content="token=\#(token);version=\#(version);min=\#(minVersion)">"#
    }

    /// Writes the meta tag as the first element of `<head>` (§2). Nil when the document has no head tag.
    static func injectMeta(into html: String, token: String) -> String? {
        guard let open = html.range(of: "<head", options: .caseInsensitive),
              let close = html.range(of: ">", range: open.upperBound..<html.endIndex) else { return nil }
        var out = html
        out.insert(contentsOf: metaTag(token: token), at: close.upperBound)
        return out
    }
}

// MARK: - Payload encoding (§5, §6)

/// What the bridge sends, as Foundation values `callAsyncJavaScript` can pass (NSNull for required nulls,
/// optional fields omitted, every number finite, seconds to the millisecond).
enum BridgePayload {
    static func seconds(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return (value * 1000).rounded() / 1000
    }

    static func layout(width: Double, height: Double, regular: Bool) -> [String: Any] {
        [
            "widthPt": seconds(width),
            "heightPt": seconds(height),
            "sizeClass": regular ? "regular" : "compact",
            // PRD 18 DUO-7: the Duo postures arrive with iPhone Duo support; every current phone is standard.
            "posture": "standard",
        ]
    }

    static func lend(_ lend: LendInfo) -> [String: Any] {
        var out: [String: Any] = [
            "playsAllowed": lend.playsAllowed,
            "playsUsed": lend.playsUsed,
            "expiresAt": lend.expiresAt.map { ($0.timeIntervalSince1970 * 1000).rounded() } ?? 0,
            "status": lend.status,
        ]
        if let reason = lend.endReason { out["endReason"] = reason }
        return out
    }

    /// The bridge ownership of a copy: `upcoming` library rows are `locked` on the wire.
    static func ownership(_ value: Ownership) -> String {
        value == .upcoming ? "locked" : value.rawValue
    }

    static func ownershipEvent(_ context: ReleaseContext) -> [String: Any] {
        var out: [String: Any] = [
            "ownership": ownership(context.ownership),
            "editionNumber": context.editionNumber.map { $0 as Any } ?? NSNull(),
            "ownerDisplayName": context.ownerDisplayName.map { $0 as Any } ?? NSNull(),
            "unwrapped": context.unwrapped,
        ]
        if let info = context.lend { out["lend"] = Self.lend(info) }
        return out
    }

    static func context(
        _ context: ReleaseContext,
        wear: [String: Any]?,
        layout: [String: Any],
        foreground: Bool,
        serverNow: Date
    ) -> [String: Any] {
        var out = ownershipEvent(context)
        out["releaseId"] = context.releaseId ?? context.slug
        out["wear"] = wear ?? NSNull()
        out["platform"] = "ios"
        out["layout"] = layout
        out["lifecycle"] = foreground ? "foreground" : "background"
        out["dropAt"] = context.dropAt.map { ($0.timeIntervalSince1970 * 1000).rounded() } ?? 0
        out["serverNow"] = (serverNow.timeIntervalSince1970 * 1000).rounded()
        return out
    }

    /// `BridgeTrack[]`: owned and lent copies hear full songs; previews (and locked copies after the drop) hear
    /// 30 second previews; locked copies before the drop get nothing (CONTRACT.md §4).
    static let previewSeconds: Double = 30

    static func tracks(_ tracks: [Track], ownership: Ownership, dropped: Bool) -> [[String: Any]] {
        let preview: Bool
        switch ownership {
        case .owned, .lent: preview = false
        case .preview: preview = true
        case .locked, .upcoming:
            guard dropped else { return [] }
            preview = true
        }
        return tracks.filter { BridgeContract.isValidTrackId($0.id) }.map { track in
            [
                "id": track.id,
                "position": track.position,
                "title": track.title,
                "durationSeconds": seconds(preview ? min(previewSeconds, track.durationSeconds) : track.durationSeconds),
                "preview": preview,
            ]
        }
    }
}
