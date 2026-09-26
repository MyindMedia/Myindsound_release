import XCTest
@testable import MyindSound

/// DS-22: the Swift segment table must be the one in src/player3d/lcd-text.ts. The test parses that file
/// (SEGMENT bit positions and every GLYPHS entry) and compares each mask, so a change on either side fails
/// here instead of drifting.
final class LCDGlyphTests: XCTestCase {
    private static let sourcePath: String = {
        // apps/ios/MyindSoundTests/LCDGlyphTests.swift -> repo root -> src/player3d/lcd-text.ts
        let here = URL(fileURLWithPath: #filePath)
        return here
            .deletingLastPathComponent() // MyindSoundTests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("src/player3d/lcd-text.ts")
            .path
    }()

    private struct Parsed {
        var segments: [String: UInt16] = [:]
        var glyphs: [Character: UInt16] = [:]
    }

    private func parseSource() throws -> Parsed {
        let source = try String(contentsOfFile: Self.sourcePath, encoding: .utf8)
        var parsed = Parsed()

        // SEGMENT = { a: 1 << 0, ... }
        let segmentRegex = try NSRegularExpression(pattern: #"^\s*(\w+):\s*1\s*<<\s*(\d+),"#, options: [.anchorsMatchLines])
        for match in segmentRegex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            let name = String(source[Range(match.range(at: 1), in: source)!])
            let shift = Int(source[Range(match.range(at: 2), in: source)!])!
            parsed.segments[name] = UInt16(1 << shift)
        }

        // GLYPHS = { ' ': 0, '-': glyph('g1 g2'), A: glyph('a b c e f g1 g2'), ... }
        let glyphRegex = try NSRegularExpression(pattern: #"^\s*(?:'(.)'|(\w)):\s*(?:glyph\('([^']*)'\)|(\d+)),"#, options: [.anchorsMatchLines])
        for match in glyphRegex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            let quoted = Range(match.range(at: 1), in: source).map { String(source[$0]) }
            let bare = Range(match.range(at: 2), in: source).map { String(source[$0]) }
            guard let key = (quoted ?? bare)?.first else { continue }
            if let names = Range(match.range(at: 3), in: source).map({ String(source[$0]) }) {
                let bits = names.split(separator: " ").reduce(UInt16(0)) { acc, name in
                    guard let bit = parsed.segments[String(name)] else {
                        XCTFail("lcd-text.ts glyph '\(key)' uses unknown segment \(name)")
                        return acc
                    }
                    return acc | bit
                }
                parsed.glyphs[key] = bits
            } else if let literal = Range(match.range(at: 4), in: source).map({ String(source[$0]) }) {
                parsed.glyphs[key] = UInt16(literal)!
            }
        }
        return parsed
    }

    func testSourceFileIsReachable() {
        XCTAssertTrue(FileManager.default.fileExists(atPath: Self.sourcePath), "lcd-text.ts not found at \(Self.sourcePath)")
    }

    func testSegmentBitsMatchSource() throws {
        let parsed = try parseSource()
        XCTAssertEqual(parsed.segments.count, 14, "lcd-text.ts SEGMENT should have 14 entries")
        for segment in LCDSegment.allCases {
            XCTAssertEqual(LCDSegment.named(segment.name), segment)
            XCTAssertEqual(parsed.segments[segment.name], segment.bit, "segment \(segment.name) bit differs from lcd-text.ts")
        }
    }

    func testEveryGlyphMatchesSource() throws {
        let parsed = try parseSource()
        XCTAssertEqual(parsed.glyphs.count, 38, "lcd-text.ts GLYPHS should have space, dash, 0-9 and A-Z (2 + 10 + 26)")
        XCTAssertEqual(Set(parsed.glyphs.keys), Set(LCDGlyphs.table.keys), "glyph set differs from lcd-text.ts")
        for (character, mask) in parsed.glyphs {
            XCTAssertEqual(LCDGlyphs.table[character], mask, "glyph '\(character)' mask differs from lcd-text.ts")
            XCTAssertEqual(LCDGlyphs.mask(for: character), mask)
        }
    }

    func testAlphabetDigitsAndSymbolsAreCovered() {
        for scalar in UnicodeScalar("A").value...UnicodeScalar("Z").value {
            XCTAssertNotNil(LCDGlyphs.table[Character(UnicodeScalar(scalar)!)])
        }
        for scalar in UnicodeScalar("0").value...UnicodeScalar("9").value {
            XCTAssertNotNil(LCDGlyphs.table[Character(UnicodeScalar(scalar)!)])
        }
        XCTAssertEqual(LCDGlyphs.table[" "], 0)
        XCTAssertEqual(LCDGlyphs.table["-"], LCDSegment.g1.bit | LCDSegment.g2.bit)
        // Anything else is blank, as `GLYPHS[text[index]] ?? 0` in lcd.ts.
        XCTAssertEqual(LCDGlyphs.mask(for: ":"), 0)
        // Lowercase is uppercased first (lcd.ts draws `content.text.toUpperCase()`).
        XCTAssertEqual(LCDGlyphs.mask(for: "a"), LCDGlyphs.table["A"])
    }

    func testLineMatchesLcdLine() {
        XCTAssertEqual(LCDGlyphs.characterCount, 11)
        XCTAssertEqual(LCDGlyphs.line("PLAY", "03"), "PLAY     03")
        XCTAssertEqual(LCDGlyphs.line("SPIN UP", "01"), "SPIN UP  01")
        XCTAssertEqual(LCDGlyphs.line("NO DISC"), "NO DISC    ")
        XCTAssertEqual(LCDGlyphs.line("CALIBRATING"), "CALIBRATING")
        XCTAssertEqual(LCDGlyphs.line("CALIBRATINGX"), "CALIBRATING")
        // lcdLine clips `left` to the room and pads it, so a long left runs straight into `right`.
        XCTAssertEqual(LCDGlyphs.line("TRACKLISTING", "07"), "TRACKLIST07")
        XCTAssertEqual(LCDGlyphs.line("NO", "0007"), "NO     0007")
        XCTAssertEqual(LCDGlyphs.line("", "12345678901234").count, 11)
    }

    func testCellsPadAndClip() {
        XCTAssertEqual(LCDGlyphs.cells("play").count, 11)
        XCTAssertEqual(String(LCDGlyphs.cells("play")), "PLAY       ")
        XCTAssertEqual(String(LCDGlyphs.cells("ABCDEFGHIJKLMNOP")), "ABCDEFGHIJK")
    }

    func testStatusContent() {
        XCTAssertEqual(LCDContent.playing(track: 3).text, "PLAY     03")
        XCTAssertTrue(LCDContent.playing(track: 3).play)
        XCTAssertEqual(LCDContent.edition(7).text, "NO     0007")
        XCTAssertEqual(LCDContent.playsLeft(3).text, "PLAYS    03")
        XCTAssertTrue(LCDContent.stopped(track: 1).stop)
    }
}

final class LaunchScreenTests: XCTestCase {
    func testScreenArgument() {
        XCTAssertEqual(LaunchScreen.fromLaunchArguments(["app", "-screen", "gallery"]), .gallery)
        XCTAssertEqual(LaunchScreen.fromLaunchArguments(["app", "-screen", "LCD"]), .lcd)
        XCTAssertEqual(LaunchScreen.fromLaunchArguments(["app", "-screen"]), .library)
        XCTAssertEqual(LaunchScreen.fromLaunchArguments(["app"]), .library)
    }
}
