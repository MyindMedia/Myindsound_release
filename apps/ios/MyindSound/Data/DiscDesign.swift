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

/// `rack` (convex/releases.ts `RackInfo`): the rack image, one still 3D render of the release in its printed
/// sleeve with the disc all the way inside (packages/minidisc `renderSleeveStill`), PNG and WebP with alpha, square.
/// The grid shows it completely still. The API's optional spin-loop fields are not read: nothing plays them.
struct RackRender: Equatable {
    var stillURL: URL
    /// The same render as WebP (smaller; iOS decodes it natively). Tried first, the PNG is the fallback.
    var stillWebpURL: URL? = nil
    /// The cartridge on its own, as the deck shows it (`renderSleeveStill` with `cartridge`): the now playing
    /// thumbnail. Nil until the portal publishes one (`rack.cartUrl`).
    var cartURL: URL? = nil

    /// Where to load the still from, best first.
    var candidates: [URL] { [stillWebpURL, stillURL].compactMap { $0 } }

    /// LIT has no portal rack (it predates the portal), so its render ships in the app, every configuration:
    /// `Resources/RackStills/<slug>-sleeve.webp`, copied from packages/minidisc/shots (`dev/stills.html`).
    static func builtIn(slug: String, bundle: Bundle = .main) -> RackRender? {
        guard slug == "lit", let url = bundle.url(forResource: "\(slug)-sleeve", withExtension: "webp") else { return nil }
        return RackRender(stillURL: url, cartURL: bundle.url(forResource: "\(slug)-cart", withExtension: "webp"))
    }
}

/// The still's fixed framing: `renderSleeveStill` renders every release with the same pose, light and camera, so
/// the sleeve's printed front lands in the same place in every image (its `face`, packages/minidisc/shots/
/// *-sleeve.json; docs/app-v1/API.md). Stickers, the loan tag and the sealed film are laid over this rectangle.
enum RackStill {
    /// The printed front, as fractions of the (square) image, origin top left: `face` in the stills'
    /// `<slug>-sleeve.json` (renderSleeveStill, square on, the live sleeve's opening frame).
    static let face = CGRect(x: 0.0630, y: 0.0954, width: 0.8740, height: 0.8546)

    /// `face` in an image drawn `side` points square.
    static func face(side: CGFloat) -> CGRect {
        CGRect(x: face.minX * side, y: face.minY * side, width: face.width * side, height: face.height * side)
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

    /// `rack: { stillUrl, stillWebpUrl?, ... }`. Nil without a usable still URL (the printed sleeve stands in).
    static func rack(_ value: JSONValue?) -> RackRender? {
        let url = { (key: String) -> URL? in
            guard let text = value?[key]?.string, let url = URL(string: text), url.scheme != nil else { return nil }
            return url
        }
        guard let still = url("stillUrl") else { return nil }
        return RackRender(stillURL: still, stillWebpURL: url("stillWebpUrl"), cartURL: url("cartWebpUrl") ?? url("cartUrl"))
    }
}
