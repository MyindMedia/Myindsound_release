import XCTest
@testable import MyindSound

/// BUN-2, BUN-3, BRG-1, BRG-3, CONTRACT.md §1 and §4: the scheme handler's traversal guard and MIME types,
/// bundle install and SHA-256 rejection, and the bridge's message validation.
final class ReleaseHostTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ReleaseHostTests-\(UUID().uuidString)", isDirectory: true)
        let bundle = root.appendingPathComponent("bundle", isDirectory: true)
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try Data("<!DOCTYPE html><html><head><title>t</title></head><body></body></html>".utf8)
            .write(to: bundle.appendingPathComponent("index.html"))
        try Data("console.log(1)".utf8).write(to: bundle.appendingPathComponent("assets/app.js"))
        try Data((0..<100).map { UInt8($0) }).write(to: bundle.appendingPathComponent("assets/clip.mp3"))
        // A secret next to the bundle, and a symlink inside it pointing out.
        try Data("secret".utf8).write(to: root.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(at: bundle.appendingPathComponent("assets/link.txt"),
                                                   withDestinationURL: root.appendingPathComponent("secret.txt"))
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private var bundleRoot: URL { root.appendingPathComponent("bundle", isDirectory: true) }

    private func resolve(_ string: String) -> URL? {
        guard let url = URL(string: string) else { return nil }
        return BundleSchemeHandler.resolve(url, slug: "lit", root: bundleRoot)
    }

    // MARK: Scheme handler: path traversal

    func testServesFilesInsideTheBundle() {
        XCTAssertEqual(resolve("myind-bundle://lit/index.html")?.lastPathComponent, "index.html")
        XCTAssertEqual(resolve("myind-bundle://lit/assets/app.js")?.lastPathComponent, "app.js")
    }

    func testRefusesTraversal() {
        XCTAssertNil(resolve("myind-bundle://lit/../../"))
        XCTAssertNil(resolve("myind-bundle://lit/../secret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/assets/../../secret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/%2e%2e/secret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/assets/%2E%2E/%2E%2E/secret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/..%2fsecret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/assets%5c..%5csecret.txt"))
        XCTAssertNil(resolve("myind-bundle://lit/index.html%00.js"))
        XCTAssertNil(resolve("myind-bundle://lit/./index.html"))
    }

    func testRefusesSymlinksOutDirectoriesOtherHostsAndSchemes() {
        XCTAssertNil(resolve("myind-bundle://lit/assets/link.txt"), "a symlink out of the root")
        XCTAssertNil(resolve("myind-bundle://lit/assets"), "a directory")
        XCTAssertNil(resolve("myind-bundle://lit/"), "the root itself")
        XCTAssertNil(resolve("myind-bundle://other/index.html"), "another release's host")
        XCTAssertNil(resolve("https://lit/index.html"), "another scheme")
        XCTAssertNil(resolve("myind-bundle://lit:8080/index.html"), "a port")
        XCTAssertNil(resolve("myind-bundle://lit/missing.js"))
    }

    func testTraversalRequestGets404() {
        let handler = BundleSchemeHandler(slug: "lit", root: bundleRoot, entry: "index.html")
        let response = handler.respond(to: URL(string: "myind-bundle://lit/../../secret.txt")!, range: nil, token: "t")
        XCTAssertEqual(response.status, 404)
        XCTAssertFalse(String(decoding: response.body, as: UTF8.self).contains("secret"))
    }

    // MARK: Scheme handler: MIME, meta tag, ranges, CSP

    func testMimeTypes() {
        let cases: [String: String] = [
            "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
            "css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8", "webp": "image/webp",
            "png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml", "ktx2": "image/ktx2",
            "glb": "model/gltf-binary", "wasm": "application/wasm", "mp3": "audio/mpeg", "m4a": "audio/mp4",
            "ttf": "font/ttf", "woff2": "font/woff2", "WEBP": "image/webp", "xyz": "application/octet-stream",
        ]
        for (ext, mime) in cases { XCTAssertEqual(BundleSchemeHandler.mimeType(forExtension: ext), mime, ext) }
    }

    func testEntryGetsTheMetaTagFirstInHead() throws {
        let handler = BundleSchemeHandler(slug: "lit", root: bundleRoot, entry: "index.html")
        let token = BridgeContract.randomHex()
        let response = handler.respond(to: URL(string: "myind-bundle://lit/index.html")!, range: nil, token: token)
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(response.head.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        XCTAssertEqual(response.head.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        let html = String(decoding: response.body, as: UTF8.self)
        XCTAssertTrue(html.contains(#"<head><meta name="myind-bridge" content="token=\#(token);version=1;min=1"><title>"#))
        XCTAssertNotNil(response.head.value(forHTTPHeaderField: "Content-Security-Policy"))
        // Other files never get the token.
        let js = handler.respond(to: URL(string: "myind-bundle://lit/assets/app.js")!, range: nil, token: token)
        XCTAssertFalse(String(decoding: js.body, as: UTF8.self).contains(token))
    }

    func testByteRanges() {
        let handler = BundleSchemeHandler(slug: "lit", root: bundleRoot, entry: "index.html")
        let url = URL(string: "myind-bundle://lit/assets/clip.mp3")!
        let partial = handler.respond(to: url, range: "bytes=10-19", token: "")
        XCTAssertEqual(partial.status, 206)
        XCTAssertEqual(Array(partial.body), Array(10...19).map(UInt8.init))
        XCTAssertEqual(partial.head.value(forHTTPHeaderField: "Content-Range"), "bytes 10-19/100")
        XCTAssertEqual(handler.respond(to: url, range: "bytes=90-", token: "").body.count, 10)
        XCTAssertEqual(Array(handler.respond(to: url, range: "bytes=-5", token: "").body), Array(95...99).map(UInt8.init))
        XCTAssertEqual(handler.respond(to: url, range: "bytes=200-300", token: "").status, 416)
        XCTAssertEqual(handler.respond(to: url, range: "items=1-2", token: "").status, 200)
    }

    // MARK: Bundle install (BUN-2, BRG-3)

    private func fixture(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "zip"))
    }

    func testInstallVerifiesAndUnpacks() throws {
        let zip = try fixture("demo-bundle")
        let sha = try BundleStore.sha256(of: zip)
        let base = root.appendingPathComponent("bundles")
        let installed = try BundleStore.installZip(at: zip, slug: "demo", version: "1.2.0", expectedSHA256: sha, into: base)
        XCTAssertEqual(installed.manifest.bridgeVersion, 1)
        XCTAssertEqual(installed.root.lastPathComponent, "1.2.0")
        XCTAssertEqual(try String(contentsOf: installed.root.appendingPathComponent("assets/stored.txt"), encoding: .utf8), "plain")
        XCTAssertTrue(try String(contentsOf: installed.root.appendingPathComponent("assets/app.js"), encoding: .utf8).hasPrefix("console.log"))
        let excluded = try base.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        XCTAssertEqual(excluded, true)
    }

    func testSHA256MismatchIsRejectedAndNothingIsInstalled() throws {
        let zip = try fixture("demo-bundle")
        let base = root.appendingPathComponent("bundles")
        XCTAssertThrowsError(try BundleStore.installZip(
            at: zip, slug: "demo", version: "1.2.0", expectedSHA256: String(repeating: "0", count: 64), into: base
        )) { XCTAssertEqual($0 as? BundleStore.StoreError, .checksumMismatch) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: base.appendingPathComponent("demo").path))
    }

    func testManifestMustMatchTheRelease() throws {
        let zip = try fixture("demo-bundle")
        let sha = try BundleStore.sha256(of: zip)
        let base = root.appendingPathComponent("bundles")
        XCTAssertThrowsError(try BundleStore.installZip(at: zip, slug: "lit", version: "1.2.0", expectedSHA256: sha, into: base))
        XCTAssertThrowsError(try BundleStore.installZip(at: zip, slug: "demo", version: "9.9.9", expectedSHA256: sha, into: base))
    }

    func testZipSlipEntryIsRefused() throws {
        let zip = try fixture("traversal-bundle")
        let sha = try BundleStore.sha256(of: zip)
        let base = root.appendingPathComponent("bundles")
        XCTAssertThrowsError(try BundleStore.installZip(at: zip, slug: "demo", version: "1.2.0", expectedSHA256: sha, into: base))
        XCTAssertFalse(FileManager.default.fileExists(atPath: base.appendingPathComponent("evil.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("evil.txt").path))
    }

    func testCompatibility() {
        func manifest(bridge: Int, minApp: String) -> BundleManifest {
            BundleManifest(releaseId: nil, slug: "lit", version: "1.0.0", entry: "index.html", bridgeVersion: bridge, minAppVersion: minApp)
        }
        XCTAssertTrue(BundleStore.isCompatible(manifest(bridge: 1, minApp: "1.0.0"), appVersion: "1.0.0"))
        XCTAssertTrue(BundleStore.isCompatible(manifest(bridge: 1, minApp: "1.0"), appVersion: "1.0.1"))
        XCTAssertFalse(BundleStore.isCompatible(manifest(bridge: 2, minApp: "1.0.0"), appVersion: "1.0.0"), "newer bridge")
        XCTAssertFalse(BundleStore.isCompatible(manifest(bridge: 0, minApp: "1.0.0"), appVersion: "1.0.0"), "older bridge")
        XCTAssertFalse(BundleStore.isCompatible(manifest(bridge: 1, minApp: "1.10.0"), appVersion: "1.9.9"), "newer app needed")
    }

    // MARK: Bridge validation (BRG-1, CONTRACT.md §1, §4)

    private let main = BridgeContract.Origin(isMainFrame: true, scheme: "myind-bundle", host: "lit", port: 0)
    private let id = "9f2c4b1ae07d4c55b8c3f1e2a6d0b7c4"

    private func decide(_ body: Any, origin: BridgeContract.Origin? = nil, seen: Set<String> = []) -> BridgeContract.Decision {
        BridgeContract.decide(body: body, origin: origin ?? main, slug: "lit", seenIds: seen)
    }

    func testValidRequests() {
        XCTAssertEqual(decide(["id": id, "method": "getContext", "params": [:]]), .call(id: id, .getContext))
        XCTAssertEqual(decide(["id": id, "method": "play", "params": ["trackId": "abc_1-2"]]), .call(id: id, .play(trackId: "abc_1-2", startAt: nil)))
        XCTAssertEqual(decide(["id": id, "method": "play", "params": ["trackId": "t", "startAt": 12.5]]), .call(id: id, .play(trackId: "t", startAt: 12.5)))
        XCTAssertEqual(decide(["id": id, "method": "seek", "params": ["seconds": 0]]), .call(id: id, .seek(seconds: 0)))
        XCTAssertEqual(decide(["id": id, "method": "setVolume", "params": ["volume": 1]]), .call(id: id, .setVolume(1)))
        XCTAssertEqual(decide(["id": NSNull(), "method": "haptic", "params": ["kind": "rigid"]]), .call(id: nil, .haptic(.rigid)))
        XCTAssertEqual(decide(["id": NSNull(), "method": "ready", "params": [:]]), .call(id: nil, .ready))
        XCTAssertEqual(decide(["id": NSNull(), "method": "playSound", "params": ["name": "disc-click"]]), .call(id: nil, .playSound("disc-click")))
    }

    func testUnknownMethod() {
        XCTAssertEqual(decide(["id": id, "method": "openURL", "params": [:]]), .reject(id: id, .init(.unknownMethod, "Unknown bridge method")))
        XCTAssertEqual(decide(["id": id, "method": "GetContext", "params": [:]]).rejectCode, "E_UNKNOWN_METHOD", "case sensitive")
        XCTAssertEqual(decide(["id": id, "method": "__proto__"]).rejectCode, "E_UNKNOWN_METHOD")
        if case .drop = decide(["id": NSNull(), "method": "openURL"]) {} else { XCTFail("an unknown notify is dropped") }
    }

    func testBadParams() {
        let bad: [[String: Any]] = [
            ["method": "play", "params": [:]],
            ["method": "play", "params": ["trackId": "../x"]],
            ["method": "play", "params": ["trackId": String(repeating: "a", count: 129)]],
            ["method": "play", "params": ["trackId": "t", "startAt": NSNull()]],
            ["method": "play", "params": ["trackId": "t", "startAt": -1]],
            ["method": "play", "params": ["trackId": "t", "extra": 1]],
            ["method": "seek", "params": ["seconds": 21_601]],
            ["method": "seek", "params": ["seconds": "10"]],
            ["method": "seek", "params": ["seconds": true]],
            ["method": "seek", "params": ["seconds": Double.nan]],
            ["method": "setVolume", "params": ["volume": 1.01]],
            ["method": "pause", "params": ["force": true]],
            ["method": "getContext", "params": "x"],
            ["method": "getContext", "params": [1, 2]],
        ]
        for var body in bad {
            body["id"] = id
            XCTAssertEqual(decide(body).rejectCode, "E_INVALID_PARAMS", "\(body)")
        }
        // Invalid notifies are dropped, never answered.
        if case .drop = decide(["id": NSNull(), "method": "haptic", "params": ["kind": "explode"]]) {} else { XCTFail() }
        if case .drop = decide(["id": NSNull(), "method": "playSound", "params": ["name": "../x"]]) {} else { XCTFail() }
    }

    func testIdRules() {
        for bad: Any in ["123", "9F2C4B1AE07D4C55B8C3F1E2A6D0B7C4", 42, ["x"]] {
            if case .drop = decide(["id": bad, "method": "getContext"]) {} else { XCTFail("\(bad)") }
        }
        // A request without an id can't be answered; a notify with one breaks the contract.
        if case .drop = decide(["id": NSNull(), "method": "getContext"]) {} else { XCTFail() }
        if case .drop = decide(["id": id, "method": "close"]) {} else { XCTFail() }
        // An id is answered once per page load.
        if case .drop = decide(["id": id, "method": "getContext"], seen: [id]) {} else { XCTFail() }
    }

    func testWrongOriginIsDropped() {
        let origins = [
            BridgeContract.Origin(isMainFrame: false, scheme: "myind-bundle", host: "lit", port: 0),
            BridgeContract.Origin(isMainFrame: true, scheme: "myind-bundle", host: "other", port: 0),
            BridgeContract.Origin(isMainFrame: true, scheme: "https", host: "lit", port: 0),
            BridgeContract.Origin(isMainFrame: true, scheme: "myind-bundle", host: "lit", port: 443),
        ]
        for origin in origins {
            if case .drop(let reason) = decide(["id": id, "method": "getContext"], origin: origin) {
                XCTAssertEqual(reason, "untrusted origin")
            } else {
                XCTFail("\(origin)")
            }
        }
    }

    @MainActor func testShimSubstitution() throws {
        let source = try XCTUnwrap(ReleaseHostController.shimSource, "native-shim.js is bundled")
        let token = BridgeContract.randomHex(), key = BridgeContract.randomHex()
        XCTAssertEqual(token.count, 32)
        XCTAssertNotEqual(token, key)
        let shim = try XCTUnwrap(BridgeContract.substituteShim(source, token: token, channelKey: key))
        XCTAssertTrue(shim.contains("'\(token)'") && shim.contains("'\(key)'"))
        XCTAssertFalse(shim.contains("__MYIND_CONNECT_TOKEN__") || shim.contains("__MYIND_CHANNEL_KEY__"))
        XCTAssertNil(BridgeContract.substituteShim(source, token: token, channelKey: token), "the two secrets differ")
        XCTAssertNil(BridgeContract.substituteShim(source, token: "short", channelKey: key))
    }

    func testNavigationPolicy() {
        var expected: URL? = URL(string: "myind-bundle://lit/index.html")
        let current = URL(string: "myind-bundle://lit/index.html")
        XCTAssertTrue(ReleaseHostController.policy(for: expected, targetIsMainFrame: true, slug: "lit", expected: &expected, current: nil))
        XCTAssertNil(expected, "the native load is allowed once")
        XCTAssertFalse(ReleaseHostController.policy(for: current, targetIsMainFrame: true, slug: "lit", expected: &expected, current: current), "page reloads go through native")
        XCTAssertFalse(ReleaseHostController.policy(for: URL(string: "https://evil.example"), targetIsMainFrame: true, slug: "lit", expected: &expected, current: current))
        XCTAssertFalse(ReleaseHostController.policy(for: URL(string: "myind-bundle://other/index.html"), targetIsMainFrame: false, slug: "lit", expected: &expected, current: current))
        XCTAssertFalse(ReleaseHostController.policy(for: URL(string: "myind-bundle://lit/x.html"), targetIsMainFrame: nil, slug: "lit", expected: &expected, current: current), "window.open")
        XCTAssertTrue(ReleaseHostController.policy(for: URL(string: "myind-bundle://lit/index.html#deck"), targetIsMainFrame: true, slug: "lit", expected: &expected, current: current), "fragment")
    }

    // MARK: Payloads (§5, §6)

    func testTracksFollowOwnership() {
        let tracks = [Track(id: "t1", position: 1, title: "A", durationSeconds: 200.1234)]
        XCTAssertEqual(BridgePayload.tracks(tracks, ownership: .owned, dropped: true).first?["preview"] as? Bool, false)
        XCTAssertEqual(BridgePayload.tracks(tracks, ownership: .owned, dropped: true).first?["durationSeconds"] as? Double, 200.123)
        XCTAssertEqual(BridgePayload.tracks(tracks, ownership: .preview, dropped: true).first?["durationSeconds"] as? Double, 30)
        XCTAssertTrue(BridgePayload.tracks(tracks, ownership: .locked, dropped: false).isEmpty)
        XCTAssertEqual(BridgePayload.tracks(tracks, ownership: .locked, dropped: true).count, 1)
    }

    func testSpectrumMatchesTheWebAnalyser() {
        let analyzer = SpectrumAnalyzer()
        let silent = analyzer.analyze([Float](repeating: 0, count: 2048), sampleRate: 44_100)
        XCTAssertEqual(silent, .silent)
        // A 1 kHz sine: the band holding 1 kHz is the loudest, the waveform spans the range, the level is ~0.7.
        let sine = (0..<2048).map { Float(sin(2 * Double.pi * 1000 * Double($0) / 44_100)) }
        var frame = analyzer.analyze(sine, sampleRate: 44_100)
        for _ in 0..<30 { frame = analyzer.analyze(sine, sampleRate: 44_100) }
        XCTAssertEqual(frame.bands.count, 64)
        XCTAssertEqual(frame.waveform.count, 128)
        let loudest = frame.bands.enumerated().max { $0.element < $1.element }!.offset
        let ratio = pow(16_000.0 / 40.0, 1.0 / 64.0)
        let band = Int(log(1000.0 / 40.0) / log(ratio))
        XCTAssertLessThanOrEqual(abs(loudest - band), 1)
        XCTAssertEqual(Double(frame.level) / 255, 0.707, accuracy: 0.02)
        XCTAssertTrue(frame.waveform.allSatisfy { (-127...127).contains($0) })
        XCTAssertTrue(frame.bands.allSatisfy { (0...255).contains($0) })
    }
}

private extension BridgeContract.Decision {
    var rejectCode: String? {
        if case .reject(_, let error) = self { return error.code.rawValue }
        return nil
    }
}
