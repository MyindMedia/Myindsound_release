import XCTest
@testable import MyindSound

/// WEAR-6 / WEAR-9: the durable play event queue. Keys are made once and survive retries, the file
/// survives a relaunch, overlapping flushes send each batch once, and only answered events leave the queue.
final class PlayEventQueueTests: XCTestCase {
    private var fileURL: URL!

    override func setUp() {
        super.setUp()
        fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("PlayEventQueueTests-\(UUID().uuidString)")
            .appendingPathComponent("play-events.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
        super.tearDown()
    }

    private func event(_ seconds: Double = 30, startedAt: Date = Date()) -> PlayEvent {
        PlayEvent(slug: "lit", trackId: "track-1", startedAt: startedAt, playedSec: seconds)
    }

    /// Records every batch it is sent; answers for every event unless told to fail.
    private final class Server: @unchecked Sendable {
        private let lock = NSLock()
        private var _batches: [[PlayEvent]] = []
        var fail = false
        var delay: Duration = .zero

        var batches: [[PlayEvent]] { lock.withLock { _batches } }

        func send(_ events: [PlayEvent]) async throws -> [String] {
            lock.withLock { _batches.append(events) }
            if delay != .zero { try await Task.sleep(for: delay) }
            if fail { throw URLError(.notConnectedToInternet) }
            return events.map(\.idempotencyKey)
        }
    }

    // MARK: Idempotency keys

    func testEveryEventGetsItsOwnUUIDKey() {
        let a = event(), b = event()
        XCTAssertNotEqual(a.idempotencyKey, b.idempotencyKey)
        XCTAssertNotNil(UUID(uuidString: a.idempotencyKey))
        // API.md: 8-128 chars of A-Z a-z 0-9 : _ -
        XCTAssertTrue(a.idempotencyKey.allSatisfy { $0.isLetter || $0.isNumber || ":_-".contains($0) })
        XCTAssertTrue((8...128).contains(a.idempotencyKey.count))
    }

    func testEnqueueIgnoresADuplicateKey() async {
        let queue = PlayEventQueue(fileURL: fileURL)
        let first = event()
        var copy = event(99)
        copy.idempotencyKey = first.idempotencyKey
        let addedFirst = await queue.enqueue(first)
        let addedCopy = await queue.enqueue(copy)
        XCTAssertTrue(addedFirst)
        XCTAssertFalse(addedCopy)
        let pending = await queue.pendingEvents
        XCTAssertEqual(pending, [first])
    }

    func testRetriedBatchKeepsTheSameKeys() async {
        let server = Server()
        server.fail = true
        let queue = PlayEventQueue(fileURL: fileURL, sender: server.send)
        await queue.enqueue(event())
        await queue.enqueue(event())
        let sentWhileOffline = await queue.flush()
        XCTAssertEqual(sentWhileOffline, 0)
        server.fail = false
        let sentOnline = await queue.flush()
        XCTAssertEqual(sentOnline, 2)
        XCTAssertEqual(server.batches.count, 2)
        XCTAssertEqual(server.batches[0].map(\.idempotencyKey), server.batches[1].map(\.idempotencyKey))
        let pending = await queue.pendingEvents
        XCTAssertTrue(pending.isEmpty)
    }

    // MARK: Persistence

    func testQueueSurvivesARelaunch() async {
        let queue = PlayEventQueue(fileURL: fileURL)
        let saved = event(42)
        await queue.enqueue(saved)

        let relaunched = PlayEventQueue(fileURL: fileURL)
        let pending = await relaunched.pendingEvents
        XCTAssertEqual(pending, [saved])
    }

    func testFlushedEventsAreGoneFromTheFile() async {
        let server = Server()
        let queue = PlayEventQueue(fileURL: fileURL, sender: server.send)
        await queue.enqueue(event())
        await queue.flush()

        let relaunched = PlayEventQueue(fileURL: fileURL)
        let pending = await relaunched.pendingEvents
        XCTAssertTrue(pending.isEmpty)
    }

    func testEventsOlderThanSixtyDaysAreDropped() async {
        let server = Server()
        let queue = PlayEventQueue(fileURL: fileURL, sender: server.send)
        await queue.enqueue(event(startedAt: Date().addingTimeInterval(-61 * 86_400)))
        await queue.enqueue(event())
        await queue.flush()
        XCTAssertEqual(server.batches.flatMap { $0 }.count, 1)
    }

    // MARK: Flush once

    func testOverlappingFlushesSendEachBatchOnce() async {
        let server = Server()
        server.delay = .milliseconds(150)
        let queue = PlayEventQueue(fileURL: fileURL, sender: server.send)
        for _ in 0..<3 { await queue.enqueue(event()) }

        async let a = queue.flush()
        async let b = queue.flush()
        async let c = queue.flush()
        let results = await [a, b, c]

        XCTAssertEqual(server.batches.count, 1, "one flush in flight; the others wait for it")
        XCTAssertEqual(server.batches.first?.count, 3)
        XCTAssertEqual(results, [3, 3, 3])
    }

    func testOnlyAnsweredEventsLeaveTheQueue() async {
        let first = event(), second = event()
        let answered = first.idempotencyKey
        let queue = PlayEventQueue(fileURL: fileURL) { events in
            // The server's reply covers the first event only.
            events.map(\.idempotencyKey).filter { $0 == answered }
        }
        await queue.enqueue(first)
        await queue.enqueue(second)
        let sent = await queue.flush()
        XCTAssertEqual(sent, 1)
        let pending = await queue.pendingEvents
        XCTAssertEqual(pending, [second])
    }

    func testLargeQueueFlushesInBatches() async {
        let server = Server()
        let queue = PlayEventQueue(fileURL: fileURL, sender: server.send)
        for _ in 0..<(PlayEventQueue.batchSize + 5) { await queue.enqueue(event()) }
        let sent = await queue.flush()
        XCTAssertEqual(sent, PlayEventQueue.batchSize + 5)
        XCTAssertEqual(server.batches.map(\.count), [PlayEventQueue.batchSize, 5])
    }

    func testPlayEventEncodesTheAPIFields() throws {
        let started = Date(timeIntervalSince1970: 1_758_000_000.25)
        let e = PlayEvent(idempotencyKey: "abcdef12", slug: "lit", trackId: "t1", startedAt: started, playedSec: 12.5)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(e)) as? [String: Any]
        XCTAssertEqual(json?["idempotencyKey"] as? String, "abcdef12")
        XCTAssertEqual(json?["trackId"] as? String, "t1")
        XCTAssertEqual(json?["startedAtClient"] as? Double, 1_758_000_000_250)
        XCTAssertEqual(json?["playedSec"] as? Double, 12.5)
        XCTAssertEqual(json?["kind"] as? String, "play")
    }
}
