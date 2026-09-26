import Foundation

/// The Convex app API as the iOS app sees it (docs/app-v1/BUILD.md). `ConvexAPI` talks to the deployment;
/// `MockAPI` serves sample data for `-mock` runs and screenshots.
protocol MyindAPI: AnyObject {
    /// `app.library()`
    func library() async throws -> LibrarySnapshot
    /// `app.context({ slug })`
    func context(slug: String) async throws -> ReleaseContext
    /// `app.tracks({ slug })`
    func tracks(slug: String) async throws -> [Track]
    /// `media.getStreamUrl({ trackId, lendId? })` (AUD-2)
    func streamURL(trackId: String, lendId: String?) async throws -> StreamURL
    /// `plays.recordPlayEvents({ events })` (WEAR-6..9). At most 500 per call. A thrown error means keep
    /// the whole batch; every returned result (recorded, duplicate or rejected) leaves the queue.
    func recordPlayEvents(_ events: [PlayEvent]) async throws -> [PlayEventResult]
    /// `app.markUnwrapped({ slug })` (RACK-3)
    func markUnwrapped(slug: String) async throws
    /// `app.recordCartridgeEvent({ slug, kind })`
    func recordCartridgeEvent(slug: String, kind: CartridgeEventKind, idempotencyKey: String) async throws
    /// `leaderboard.forRelease({ slug, limit })` (LB-1)
    func leaderboard(slug: String, limit: Int) async throws -> Leaderboard
    /// `leaderboard.myAwards()` (LB-6)
    func myAwards() async throws -> AwardsSummary
    /// `push.registerToken({ token, platform: 'ios', wantsDropAlerts, environment })`
    func registerPushToken(_ token: String, wantsDropAlerts: Bool, sandbox: Bool) async throws
    /// `push.unregisterToken({ token })`, on sign out.
    func unregisterPushToken(_ token: String) async throws
    /// `privacy.exportMyData()`: the raw JSON, handed to the share sheet as a file.
    func exportMyData() async throws -> Data
    /// `privacy.deleteMyData({ confirm: 'DELETE' })`
    func deleteMyData() async throws
}

/// Convex function names, one place (module:function).
enum ConvexFunction {
    static let library = "app:library"
    static let context = "app:context"
    static let tracks = "app:tracks"
    static let streamURL = "media:getStreamUrl"
    static let recordPlayEvents = "plays:recordPlayEvents"
    static let markUnwrapped = "app:markUnwrapped"
    static let recordCartridgeEvent = "app:recordCartridgeEvent"
    static let leaderboard = "leaderboard:forRelease"
    static let myAwards = "leaderboard:myAwards"
    static let registerPushToken = "push:registerToken"
    static let unregisterPushToken = "push:unregisterToken"
    static let exportMyData = "privacy:exportMyData"
    static let deleteMyData = "privacy:deleteMyData"
}
