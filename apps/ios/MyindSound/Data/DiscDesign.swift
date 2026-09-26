import CoreGraphics
import Foundation

// Generated discs (Grilled.md "Release portal + generated discs", packages/minidisc/README.md). A release made
// in the portal carries its `design` (DiscDesign v1), a pre-rendered spin loop for the rack (`rack`) and its own
// bundle. LIT has neither design nor rack: it keeps its built-in sleeve art and the city backdrop.

/// The parts of `DiscDesign` v1 the native app reads (the bundle reads the full file from its own zip). Every
/// field is optional so a newer design never fails the decode.
struct DiscDesign: Equatable {
    struct Backdrop: Equatable {
        /// Relative to the design file, or absolute. Defaults to the cover.
        var image: String?
        /// Blur at a 390 pt wide screen (README "ArtBackdrop"). Default 12.
        var blurPx: Double?
        /// Ink scrim over the art, 0...1. Default 0.62.
        var scrim: Double?
    }

    struct Theme: Equatable {
        var accent: String?
        var accent2: String?
        var lcdTint: String?
        var backdropImage: String?
        var backdrop: Backdrop?
    }

    struct Track: Equatable {
        var n: Int
        var title: String
        var durationSec: Double
    }

    var slug: String?
    var title: String?
    var artist: String?
    var year: Int?
    var coverArt: String?
    var discArt: String?
    var shell: String?
    var accent: String?
    var theme: Theme?
    var tracks: [Track] = []
    /// Where relative art paths resolve (the design file's folder). Nil for designs from the API, whose
    /// relative art lives in the installed bundle's `design/` folder instead.
    var baseURL: URL?

    static let defaultBlurPx: Double = 12
    static let defaultScrim: Double = 0.62

    /// `theme.backdrop.image`, else the cover (README: "defaults: the cover").
    var backdropArt: String? { theme?.backdrop?.image ?? coverArt }

    /// An art reference as a URL: absolute http(s) or file URLs as they are, relative ones against `baseURL`.
    func resolve(_ reference: String?) -> URL? {
        guard let reference, !reference.isEmpty else { return nil }
        if let url = URL(string: reference), let scheme = url.scheme?.lowercased(), ["https", "http", "file"].contains(scheme) {
            return url
        }
        guard let baseURL else { return nil }
        return URL(string: reference, relativeTo: baseURL)?.absoluteURL
    }
}

/// `rack.spriteMeta`: the sheet layout `renderSpinLoop` wrote (packages/minidisc/src/sprite.ts: row major, no
/// padding, cell `i` at `((i % cols) * frameW, floor(i / cols) * frameH)`).
struct SpriteMeta: Equatable {
    var frames: Int
    var cols: Int
    var rows: Int
    var frameW: Int
    var frameH: Int
    var sheetW: Int
    var sheetH: Int
    var fps: Double

    /// The layout is usable: at least one frame, every cell inside the sheet.
    var isValid: Bool {
        frames > 0 && cols > 0 && rows > 0 && frameW > 0 && frameH > 0 && frames <= cols * rows
            && cols * frameW <= sheetW && rows * frameH <= sheetH && fps > 0
    }
}

/// `rack` (convex/releases.ts `RackInfo`): the release's spin loop for the grid (the sleeved cartridge, disc turning inside the casing).
struct RackRender: Equatable {
    var spriteURL: URL
    /// `webp` or `png`.
    var spriteFormat: String
    var meta: SpriteMeta
    var stillURL: URL?
    /// `pngSpriteUrl`: the same layout as PNG, used when the WebP sheet can't be had or decoded.
    var pngURL: URL? = nil
}

/// The sheet maths: which rectangle of the decoded sheet is frame `i`. The decoded image may be smaller than
/// `meta.sheetW × meta.sheetH` (downsampled for the tile), so rects scale to it.
enum SpriteSheet {
    static func cell(_ index: Int, meta: SpriteMeta) -> CGRect? {
        guard meta.isValid, index >= 0, index < meta.frames else { return nil }
        return CGRect(
            x: (index % meta.cols) * meta.frameW,
            y: (index / meta.cols) * meta.frameH,
            width: meta.frameW,
            height: meta.frameH
        )
    }

    /// Frame `index` in a sheet decoded at `pixelWidth × pixelHeight`, snapped to whole pixels.
    static func cell(_ index: Int, meta: SpriteMeta, pixelWidth: Int, pixelHeight: Int) -> CGRect? {
        guard let rect = cell(index, meta: meta), pixelWidth > 0, pixelHeight > 0 else { return nil }
        let sx = CGFloat(pixelWidth) / CGFloat(meta.sheetW)
        let sy = CGFloat(pixelHeight) / CGFloat(meta.sheetH)
        let x0 = (rect.minX * sx).rounded(), y0 = (rect.minY * sy).rounded()
        let x1 = min(CGFloat(pixelWidth), (rect.maxX * sx).rounded())
        let y1 = min(CGFloat(pixelHeight), (rect.maxY * sy).rounded())
        guard x1 > x0, y1 > y0 else { return nil }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// Every frame's rect, in order.
    static func cells(meta: SpriteMeta, pixelWidth: Int, pixelHeight: Int) -> [CGRect] {
        (0..<max(0, meta.frames)).compactMap { cell($0, meta: meta, pixelWidth: pixelWidth, pixelHeight: pixelHeight) }
    }

    /// Which frame shows at `time` seconds, looping at `meta.fps`.
    static func frameIndex(at time: TimeInterval, frames: Int, fps: Double) -> Int {
        guard frames > 0, fps > 0, time.isFinite else { return 0 }
        let n = Int((time * fps).rounded(.down)) % frames
        return n < 0 ? n + frames : n
    }
}

// MARK: Decoding (tolerant, API.md style: a missing or malformed field is nil, never a failed library)

extension APIDecoding {
    static func design(_ value: JSONValue?) -> DiscDesign? {
        guard let value, value.object != nil else { return nil }
        let theme = value["theme"].flatMap { theme -> DiscDesign.Theme? in
            guard theme.object != nil else { return nil }
            let backdrop = theme["backdrop"].flatMap { b -> DiscDesign.Backdrop? in
                guard b.object != nil else { return nil }
                return DiscDesign.Backdrop(image: b["image"]?.string, blurPx: b["blurPx"]?.double, scrim: b["scrim"]?.double)
            }
            return DiscDesign.Theme(
                accent: theme["accent"]?.string,
                accent2: theme["accent2"]?.string,
                lcdTint: theme["lcdTint"]?.string,
                backdropImage: theme["backdropImage"]?.string,
                backdrop: backdrop
            )
        }
        let tracks: [DiscDesign.Track] = (value["tracks"]?.array ?? []).enumerated().compactMap { index, row in
            guard let title = row["title"]?.string else { return nil }
            return DiscDesign.Track(n: row["n"]?.int ?? index + 1, title: title, durationSec: row["durationSec"]?.double ?? 0)
        }
        return DiscDesign(
            slug: value["slug"]?.string,
            title: value["title"]?.string,
            artist: value["artist"]?.string,
            year: value["year"]?.int,
            coverArt: value["coverArt"]?.string,
            discArt: value["discArt"]?.string,
            shell: value["shell"]?.string,
            accent: value["accent"]?.string,
            theme: theme,
            tracks: tracks
        )
    }

    static func spriteMeta(_ value: JSONValue?) -> SpriteMeta? {
        guard let value, let frames = value["frames"]?.int, let cols = value["cols"]?.int,
              let frameW = value["frameW"]?.int, let frameH = value["frameH"]?.int else { return nil }
        let rows = value["rows"]?.int ?? Int((Double(frames) / Double(max(1, cols))).rounded(.up))
        let meta = SpriteMeta(
            frames: frames,
            cols: cols,
            rows: rows,
            frameW: frameW,
            frameH: frameH,
            sheetW: value["sheetW"]?.int ?? cols * frameW,
            sheetH: value["sheetH"]?.int ?? rows * frameH,
            fps: value["fps"]?.double ?? 24
        )
        return meta.isValid ? meta : nil
    }

    /// `rack: { spriteUrl, spriteFormat, spriteMeta, stillUrl }`. Nil without a sheet or a usable layout.
    static func rack(_ value: JSONValue?) -> RackRender? {
        guard let value, let text = value["spriteUrl"]?.string, let url = URL(string: text), url.scheme != nil,
              let meta = spriteMeta(value["spriteMeta"]) else { return nil }
        let format = value["spriteFormat"]?.string?.lowercased()
            ?? value["spriteMeta"]?["format"]?.string.map { $0.contains("webp") ? "webp" : "png" }
            ?? (url.pathExtension.lowercased() == "webp" ? "webp" : "png")
        return RackRender(
            spriteURL: url,
            spriteFormat: format == "webp" ? "webp" : "png",
            meta: meta,
            stillURL: value["stillUrl"]?.string.flatMap(URL.init(string:)),
            pngURL: value["pngSpriteUrl"]?.string.flatMap(URL.init(string:))
        )
    }
}
