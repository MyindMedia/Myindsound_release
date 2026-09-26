import AVFoundation
import CryptoKit
import XCTest
@testable import MyindSound

/// AUD-3..6: the chunked AES-GCM format (round trip, tamper and truncation detection, ranges across chunk
/// boundaries), the resource loader, the 30 day recheck gate and revocation on sync.
final class DownloadTests: XCTestCase {
    private var dir: URL!
    private let key = SymmetricKey(size: .bits256)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("DownloadTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func sample(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) })
    }

    private func write(_ data: Data, chunk: Int = 1000) throws -> URL {
        let url = dir.appendingPathComponent("\(UUID().uuidString).mse")
        try EncryptedAudioFile.write(data, to: url, key: key, chunkSize: chunk)
        return url
    }

    // MARK: Round trip

    func testRoundTrip() throws {
        for size in [0, 1, 999, 1000, 1001, 5000, 12_345] {
            let plain = sample(size)
            let url = try write(plain)
            let reader = try EncryptedAudioFile.Reader(fileURL: url, key: key)
            XCTAssertEqual(reader.length, UInt64(size))
            XCTAssertEqual(try reader.read(offset: 0, count: size + 10), plain, "size \(size)")
            // The file size is exactly what the header implies, and holds no plaintext run.
            let onDisk = try Data(contentsOf: url)
            XCTAssertEqual(UInt64(onDisk.count), reader.header.fileSize)
            if size >= 64 { XCTAssertNil(onDisk.range(of: plain.prefix(64)), "plaintext on disk") }
        }
    }

    func testRangesAcrossChunkBoundaries() throws {
        let plain = sample(10_500)
        let reader = try EncryptedAudioFile.Reader(fileURL: try write(plain, chunk: 1000), key: key)
        let ranges: [(UInt64, Int)] = [(0, 1), (999, 2), (995, 10), (1000, 1000), (1500, 3000), (9999, 600), (10_499, 5), (10_500, 5), (0, 10_500)]
        for (offset, count) in ranges {
            let end = min(plain.count, Int(offset) + count)
            XCTAssertEqual(try reader.read(offset: offset, count: count), plain.subdata(in: Int(offset)..<end), "\(offset)+\(count)")
        }
        XCTAssertThrowsError(try reader.read(offset: 10_501, count: 1))
    }

    // MARK: Tamper detection

    func testFlippedByteFailsAuthentication() throws {
        let url = try write(sample(3000))
        var bytes = try Data(contentsOf: url)
        // Inside chunk 1's ciphertext.
        let target = EncryptedAudioFile.headerSize + (1000 + EncryptedAudioFile.overhead) + EncryptedAudioFile.nonceSize + 10
        bytes[target] ^= 0x01
        try bytes.write(to: url)
        let reader = try EncryptedAudioFile.Reader(fileURL: url, key: key)
        XCTAssertNoThrow(try reader.read(offset: 0, count: 1000), "other chunks still open")
        XCTAssertThrowsError(try reader.read(offset: 1000, count: 10)) {
            XCTAssertEqual($0 as? EncryptedAudioFile.FormatError, .authenticationFailed(chunk: 1))
        }
    }

    func testSwappedChunksFail() throws {
        let url = try write(sample(3000))
        var bytes = try Data(contentsOf: url)
        let stride = 1000 + EncryptedAudioFile.overhead
        let a = EncryptedAudioFile.headerSize, b = a + stride
        let first = bytes.subdata(in: a..<(a + stride)), second = bytes.subdata(in: b..<(b + stride))
        bytes.replaceSubrange(a..<(a + stride), with: second)
        bytes.replaceSubrange(b..<(b + stride), with: first)
        try bytes.write(to: url)
        let reader = try EncryptedAudioFile.Reader(fileURL: url, key: key)
        XCTAssertThrowsError(try reader.read(offset: 0, count: 1))
    }

    func testTruncationAndLengthEditsFail() throws {
        // Cut at a chunk boundary and fix the length to match: the new last chunk wasn't sealed as final.
        let url = try write(sample(3000))
        var bytes = try Data(contentsOf: url)
        let keep = EncryptedAudioFile.headerSize + 2 * (1000 + EncryptedAudioFile.overhead)
        bytes = bytes.prefix(keep)
        var length = UInt64(2000).bigEndian
        bytes.replaceSubrange(28..<36, with: Data(bytes: &length, count: 8))
        try bytes.write(to: url)
        let reader = try EncryptedAudioFile.Reader(fileURL: url, key: key)
        XCTAssertThrowsError(try reader.read(offset: 1500, count: 10))

        // Cut without fixing the length: the size no longer matches.
        let other = try write(sample(3000))
        let cut = try Data(contentsOf: other).dropLast(5)
        try Data(cut).write(to: other)
        XCTAssertThrowsError(try EncryptedAudioFile.Reader(fileURL: other, key: key))
    }

    func testWrongKeyFails() throws {
        let reader = try EncryptedAudioFile.Reader(fileURL: try write(sample(100)), key: SymmetricKey(size: .bits256))
        XCTAssertThrowsError(try reader.read(offset: 0, count: 10))
    }

    // MARK: Resource loader (AUD-4)

    func testLoaderAnswersRangesWithPlaintext() throws {
        let plain = sample(700_000)
        let url = try write(plain, chunk: EncryptedAudioFile.defaultChunkSize)
        let loader = try EncryptedAssetLoader(fileURL: url, key: key, mimeType: "audio/mpeg")
        XCTAssertEqual(loader.contentType, "public.mp3")
        XCTAssertEqual(try loader.reader.read(offset: 262_000, count: 1000), plain.subdata(in: 262_000..<263_000))
        let asset = loader.makeAsset(trackId: "t1")
        XCTAssertEqual(asset.url.scheme, "myind-enc")
        XCTAssertTrue(asset.resourceLoader.delegate === loader)
    }

    /// AVFoundation really decodes through the loader: a WAV made here, encrypted, the plain copy deleted,
    /// then loaded as `myind-enc://` and played by an AVPlayer until time moves.
    func testAVPlayerPlaysThroughTheLoader() async throws {
        let plainURL = dir.appendingPathComponent("tone.wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        do {
            let file = try AVAudioFile(forWriting: plainURL, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
            ])
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 88_200)!
            buffer.frameLength = 88_200
            for i in 0..<88_200 { buffer.floatChannelData![0][i] = Float(sin(2 * Double.pi * 440 * Double(i) / 44_100)) * 0.2 }
            try file.write(from: buffer)
        }
        let encrypted = try write(try Data(contentsOf: plainURL), chunk: 16_384)
        try FileManager.default.removeItem(at: plainURL)

        let loader = try EncryptedAssetLoader(fileURL: encrypted, key: key, mimeType: "audio/wav")
        let asset = loader.makeAsset(trackId: "tone")
        let playable = try await asset.load(.isPlayable)
        let duration = try await asset.load(.duration).seconds
        XCTAssertTrue(playable)
        XCTAssertEqual(duration, 2, accuracy: 0.05)
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        player.volume = 0
        player.play()
        for _ in 0..<40 where player.currentTime().seconds < 0.3 { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertGreaterThan(player.currentTime().seconds, 0.3, "playback advanced through decrypted ranges")
        player.pause()
    }

    // MARK: AUD-5

    func testThirtyDayRecheckGate() {
        let checked = Date(timeIntervalSince1970: 1_800_000_000)
        let day: TimeInterval = 86_400
        XCTAssertTrue(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked))
        XCTAssertTrue(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked.addingTimeInterval(29 * day)))
        XCTAssertTrue(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked.addingTimeInterval(30 * day)))
        XCTAssertFalse(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked.addingTimeInterval(30 * day + 1)))
        XCTAssertFalse(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked.addingTimeInterval(-2 * day)), "clock wound back")
        XCTAssertTrue(DownloadManager.canPlay(lastVerifiedAt: checked, now: checked.addingTimeInterval(-3600)), "small skew is fine")
    }

    func testOwnersOnly() {
        var release = MockAPI.lit
        XCTAssertTrue(DownloadManager.canDownload(release))
        release.ownership = .lent
        XCTAssertFalse(DownloadManager.canDownload(release))
        release.ownership = .owned
        release.lend = LendInfo(lendId: "l", playsAllowed: 3, playsUsed: 0, expiresAt: nil, status: "active", endReason: nil, role: .borrower)
        XCTAssertFalse(DownloadManager.canDownload(release))
    }

    // MARK: AUD-5 gating + AUD-6 revocation through the manager

    @MainActor
    func testSyncGatesAndRevokes() throws {
        let manager = DownloadManager(api: MockAPI(), root: dir)
        manager.setUser("user-\(UUID().uuidString)")
        defer { manager.setUser(nil) }
        // A finished download, as the manager writes it.
        let account = try XCTUnwrap(manager.debugAccount)
        let folder = dir.appendingPathComponent(account).appendingPathComponent("lit")
        let key = try XCTUnwrap(try DownloadKeychain.key(account: account, create: true))
        let name = DownloadManager.fileName(for: "mock-lit-1")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try EncryptedAudioFile.write(sample(5000), to: folder.appendingPathComponent(name), key: key)
        let old = Date().addingTimeInterval(-31 * 86_400)
        manager.debugSeed(slug: "lit", files: [.init(trackId: "mock-lit-1", file: name, length: 5000, mimeType: "audio/mpeg")], verifiedAt: old)

        XCTAssertEqual(manager.state(for: "lit"), .needsCheck)
        XCTAssertNil(manager.asset(slug: "lit", trackId: "mock-lit-1"), "AUD-5: no playback past 30 days")

        manager.sync(LibrarySnapshot(releases: [MockAPI.lit], upcoming: [], serverNow: Date()))
        XCTAssertEqual(manager.state(for: "lit"), .downloaded)
        XCTAssertNotNil(manager.asset(slug: "lit", trackId: "mock-lit-1"), "a successful check unlocks it")

        manager.sync(LibrarySnapshot(releases: [], upcoming: [], serverNow: Date()))
        XCTAssertEqual(manager.state(for: "lit"), .none)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), "AUD-6: files deleted")
        XCTAssertNil(try DownloadKeychain.key(account: account, create: false), "AUD-6: key deleted with the last download")
    }
}
