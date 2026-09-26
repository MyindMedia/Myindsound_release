import Foundation

/// WEAR-6 and WEAR-9: play sessions wait here, in a JSON file in Application Support, until Convex has them.
/// Each event keeps the UUID it was given on the device, so a batch that is sent twice (a timeout after the
/// server already committed it) is ignored server side rather than counted twice.
///
/// - `enqueue` writes to disk before returning; a crash or a kill loses nothing.
/// - `flush` sends in batches and drops only the events the server answered for (API.md: `recorded`,
///   `duplicate` and `rejected` all leave the queue; a thrown error keeps the whole batch). Calls that
///   overlap share one flush, so a foreground and a track end arriving together never send a batch twice.
actor PlayEventQueue {
    /// Sends one batch; returns the idempotency keys the server answered for.
    typealias Sender = @Sendable ([PlayEvent]) async throws -> [String]

    /// API.md allows 500 per call.
    static let batchSize = 100
    /// WEAR-7 rejects events started more than 60 days ago; there is no point keeping them.
    static let maxAge: TimeInterval = 60 * 86_400
    /// A ceiling on the file so a device that never reaches the server can't grow it without bound.
    static let maxPending = 5_000

    private let fileURL: URL
    private var sender: Sender?
    private var pending: [PlayEvent]
    private var inFlight: Task<Int, Never>?
    private let now: @Sendable () -> Date

    init(fileURL: URL = PlayEventQueue.defaultFileURL, sender: Sender? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.fileURL = fileURL
        self.sender = sender
        self.now = now
        self.pending = Self.load(from: fileURL)
    }

    static var defaultFileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("MyindSound", isDirectory: true).appendingPathComponent("play-events.json")
    }

    func setSender(_ sender: @escaping Sender) {
        self.sender = sender
    }

    var pendingEvents: [PlayEvent] { pending }

    /// Adds `event` and persists it. Returns false (and changes nothing) when an event with the same key is
    /// already waiting.
    @discardableResult
    func enqueue(_ event: PlayEvent) -> Bool {
        guard !pending.contains(where: { $0.idempotencyKey == event.idempotencyKey }) else { return false }
        pending.append(event)
        if pending.count > Self.maxPending {
            pending.removeFirst(pending.count - Self.maxPending)
        }
        persist()
        return true
    }

    /// Sends everything waiting. Returns how many events left the queue during this flush.
    @discardableResult
    func flush() async -> Int {
        if let inFlight { return await inFlight.value }
        let task = Task { await self.drain() }
        inFlight = task
        let sent = await task.value
        inFlight = nil
        return sent
    }

    private func drain() async -> Int {
        pruneExpired()
        guard let sender else { return 0 }
        var sent = 0
        while !pending.isEmpty {
            let batch = Array(pending.prefix(Self.batchSize))
            let answered: Set<String>
            do {
                answered = Set(try await sender(batch))
            } catch {
                // Kept, keys unchanged, for the next foreground or track end.
                return sent
            }
            let before = pending.count
            pending.removeAll { answered.contains($0.idempotencyKey) }
            let removed = before - pending.count
            sent += removed
            persist()
            // A reply that answered none of the batch would loop forever; try again next time.
            if removed == 0 { return sent }
        }
        return sent
    }

    private func pruneExpired() {
        let cutoff = (now().timeIntervalSince1970 - Self.maxAge) * 1000
        let before = pending.count
        pending.removeAll { $0.startedAtClient < cutoff }
        if pending.count != before { persist() }
    }

    // MARK: File

    private func persist() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(pending)
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            // Nothing sensitive to log: counts only.
            print("PlayEventQueue: could not save \(pending.count) events")
        }
    }

    private static func load(from url: URL) -> [PlayEvent] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([PlayEvent].self, from: data)) ?? []
    }
}
