import Foundation

/// Static sample data for the first screen shells. Titles are LIT's real tracklist (scripts/lit-tracks.json);
/// durations are the 30 s previews from src/player3d/lit-previews.json, the only lengths in the repo.
enum LITSample {
    struct Track: Identifiable {
        let position: Int
        let title: String
        let durationSeconds: Double
        var id: Int { position }
        var duration: String {
            let s = Int(durationSeconds.rounded())
            return "\(s / 60):" + String(format: "%02d", s % 60)
        }
    }

    static let albumTitle = "LIT"
    static let artist = "Tha Myind"
    static let year = "2026"

    static let tracks: [Track] = [
        Track(position: 1, title: "L.I.T. (Living In Truth)", durationSeconds: 30),
        Track(position: 2, title: "G. O. D.", durationSeconds: 30),
        Track(position: 3, title: "Victory In the Valley", durationSeconds: 30),
        Track(position: 4, title: "Tired", durationSeconds: 30),
        Track(position: 5, title: "Let Him Cook", durationSeconds: 30),
        Track(position: 6, title: "He The Truth", durationSeconds: 30),
        Track(position: 7, title: "Faith", durationSeconds: 30),
    ]

    static let currentTrack = 1
    static let editionNumber = 7
    static let plays = 128
    static let wearLevel = "LIGHT"
    static let wearPercent = 3
    static let repeatOn = false

    static let nowPlayingTitle = "01 · L.I.T. (Living In Truth)"
    static let nowPlayingTag = "Preview"
    static let nowPlayingElapsed = "0:01"
    static let nowPlayingDuration = "0:30"
    static let nowPlayingProgress = 1.0 / 30.0

    static let greeting = "Welcome back, Lawrence"
}
