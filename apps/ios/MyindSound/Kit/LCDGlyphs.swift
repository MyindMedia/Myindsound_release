import Foundation

/// The deck's 14-segment character set, ported one for one from src/player3d/lcd-text.ts (`SEGMENT`,
/// `GLYPHS`, `LCD_CHARS`, `lcdLine`). The unit test `LCDGlyphTests` parses that file and checks every mask
/// here against it, so the two cannot drift silently.
///
/// Outer ring: a (top), b, c (right, top to bottom), d (bottom), e, f (left, bottom to top). Middle bar:
/// g1 (left half), g2 (right half). Inner strokes from the centre: h (to top-left), i (up), j (to top-right),
/// k (to bottom-left), l (down), m (to bottom-right).
enum LCDSegment: Int, CaseIterable {
    case a = 0, b, c, d, e, f, g1, g2, h, i, j, k, l, m

    var bit: UInt16 { 1 << UInt16(rawValue) }

    var name: String {
        switch self {
        case .a: return "a"
        case .b: return "b"
        case .c: return "c"
        case .d: return "d"
        case .e: return "e"
        case .f: return "f"
        case .g1: return "g1"
        case .g2: return "g2"
        case .h: return "h"
        case .i: return "i"
        case .j: return "j"
        case .k: return "k"
        case .l: return "l"
        case .m: return "m"
        }
    }

    static func named(_ name: String) -> LCDSegment? {
        allCases.first { $0.name == name }
    }
}

enum LCDGlyphs {
    /// lcd-text.ts `LCD_CHARS`.
    static let characterCount = MSComponent.LCD.characterCount

    private static func glyph(_ names: String) -> UInt16 {
        names.split(separator: " ").reduce(0) { bits, name in
            bits | (LCDSegment.named(String(name))?.bit ?? 0)
        }
    }

    /// lcd-text.ts `GLYPHS`: the usual 14-segment alphanumeric font (as on LED backpack displays).
    static let table: [Character: UInt16] = [
        " ": 0,
        "-": glyph("g1 g2"),
        "0": glyph("a b c d e f"),
        "1": glyph("b c"),
        "2": glyph("a b d e g1 g2"),
        "3": glyph("a b c d g2"),
        "4": glyph("b c f g1 g2"),
        "5": glyph("a c d f g1 g2"),
        "6": glyph("a c d e f g1 g2"),
        "7": glyph("a b c"),
        "8": glyph("a b c d e f g1 g2"),
        "9": glyph("a b c d f g1 g2"),
        "A": glyph("a b c e f g1 g2"),
        "B": glyph("a b c d g2 i l"),
        "C": glyph("a d e f"),
        "D": glyph("a b c d i l"),
        "E": glyph("a d e f g1"),
        "F": glyph("a e f g1"),
        "G": glyph("a c d e f g2"),
        "H": glyph("b c e f g1 g2"),
        "I": glyph("a d i l"),
        "J": glyph("b c d e"),
        "K": glyph("e f g1 j m"),
        "L": glyph("d e f"),
        "M": glyph("b c e f h j"),
        "N": glyph("b c e f h m"),
        "O": glyph("a b c d e f"),
        "P": glyph("a b e f g1 g2"),
        "Q": glyph("a b c d e f m"),
        "R": glyph("a b e f g1 g2 m"),
        "S": glyph("a c d f g1 g2"),
        "T": glyph("a i l"),
        "U": glyph("b c d e f"),
        "V": glyph("e f j k"),
        "W": glyph("b c e f k m"),
        "X": glyph("h j k m"),
        "Y": glyph("h j l"),
        "Z": glyph("a d j k"),
    ]

    /// Segment mask for one character; anything not in the table (lowercase is uppercased first) is blank,
    /// as `GLYPHS[text[index]] ?? 0` does in lcd.ts.
    static func mask(for character: Character) -> UInt16 {
        table[Character(character.uppercased())] ?? 0
    }

    /// lcd-text.ts `lcdLine`: `left` from the first character, `right` against the last, clipped to the display.
    static func line(_ left: String, _ right: String = "") -> String {
        let room = max(0, characterCount - right.count)
        let head = String(left.prefix(room)).padding(toLength: room, withPad: " ", startingAt: 0)
        return String((head + right).prefix(characterCount))
    }

    /// App-only colons (DS-22 `DROP 02:14:07`): a `:` takes no cell of its own, it lights two dots in the gap after
    /// the cell before it, as the colon on a clock LCD does. `colonsAfter` holds those cell indexes. Text with no
    /// colon lays out exactly as `cells` (the deck's own lines never carry one).
    static func layout(_ text: String) -> (cells: [Character], colonsAfter: Set<Int>) {
        var stripped = ""
        var colons = Set<Int>()
        for character in text {
            if character == ":" {
                if !stripped.isEmpty { colons.insert(stripped.count - 1) }
            } else {
                stripped.append(character)
            }
        }
        return (cells(stripped), colons.filter { $0 < characterCount - 1 })
    }

    /// lcd.ts `draw`: uppercase, padded and clipped to the 11 cells.
    static func cells(_ text: String) -> [Character] {
        let padded = text.uppercased().padding(toLength: characterCount, withPad: " ", startingAt: 0)
        return Array(padded.prefix(characterCount))
    }
}

/// lcd-text.ts `LcdContent`: one 11-character line and the mode flags above it.
struct LCDContent: Equatable {
    var text: String
    var play = false
    var pause = false
    var stop = false
    var repeat_ = false

    init(_ text: String, play: Bool = false, pause: Bool = false, stop: Bool = false, `repeat`: Bool = false) {
        self.text = text
        self.play = play
        self.pause = pause
        self.stop = stop
        self.repeat_ = `repeat`
    }

    /// The deck's status words (lcd-text.ts `STATUS_LINE`, DS-5).
    static let noDisc = LCDContent("NO DISC")
    static let loading = LCDContent("LOADING")
    static let reading = LCDContent("READING")
    static let calibrating = LCDContent("CALIBRATING")
    static let ejecting = LCDContent("EJECTING")
    static func playing(track: Int) -> LCDContent { LCDContent(LCDGlyphs.line("PLAY", pad2(track)), play: true) }
    static func paused(track: Int) -> LCDContent { LCDContent(LCDGlyphs.line("PAUSE", pad2(track)), pause: true) }
    static func stopped(track: Int) -> LCDContent { LCDContent(LCDGlyphs.line("STOP", pad2(track)), stop: true) }
    static func spinUp(track: Int) -> LCDContent { LCDContent(LCDGlyphs.line("SPIN UP", pad2(track))) }
    /// DS-22 app uses: edition numbers and lend plays left.
    static func edition(_ number: Int) -> LCDContent { LCDContent(LCDGlyphs.line("NO", String(format: "%04d", number))) }
    static func playsLeft(_ plays: Int) -> LCDContent { LCDContent(LCDGlyphs.line("PLAYS", pad2(plays))) }

    private static func pad2(_ n: Int) -> String { String(format: "%02d", n) }
}
