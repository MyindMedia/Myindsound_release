import SwiftUI
import UIKit

/// What sits behind a release's native screens (Grilled.md "Player background").
enum BackdropChoice: Equatable {
    /// The LIT city (LIT, releases without a design, and art that can't be found).
    case city
    /// The album's cover, blurred `blurPx` (at a 390 pt wide screen) under an ink `scrim`.
    case art(URL, blurPx: Double, scrim: Double)

    var artURL: URL? {
        if case .art(let url, _, _) = self { return url }
        return nil
    }
}

enum BackdropRules {
    /// The scrim never drops below this, so muted text keeps 4.5:1 over the brightest cover.
    static let minScrim: Double = 0.5
    static let maxBlurPx: Double = 40

    /// The backdrop for a release. Only generated discs (with a design) follow their art; LIT keeps its city.
    /// Art, best first: the library's `coverUrl`, the design's backdrop image, its cover, then the same file
    /// inside the installed bundle. Blur and scrim come from `design.theme.backdrop`, defaults 12 and 0.62.
    static func choice(coverURL: URL?, design: DiscDesign?, bundledArt: URL?) -> BackdropChoice {
        guard let design else { return .city }
        let candidates: [URL?] = [
            coverURL,
            design.resolve(design.theme?.backdrop?.image),
            design.resolve(design.coverArt),
            bundledArt,
        ]
        guard let url = candidates.compactMap({ $0 }).first else { return .city }
        let blur = design.theme?.backdrop?.blurPx ?? DiscDesign.defaultBlurPx
        let scrim = design.theme?.backdrop?.scrim ?? DiscDesign.defaultScrim
        return .art(
            url,
            blurPx: min(maxBlurPx, max(0, blur.isFinite ? blur : DiscDesign.defaultBlurPx)),
            scrim: min(0.95, max(minScrim, scrim.isFinite ? scrim : DiscDesign.defaultScrim))
        )
    }
}

/// Cover art for the backdrops and the sleeves on the release pages: downsampled, optionally pre-blurred once
/// (never per frame), cached in memory and on disk (ArtCache).
enum ArtImageLoader {
    private static let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()

    private static func key(_ url: URL, blurPx: Double, maxPixel: Int) -> NSString {
        "\(url.absoluteString)#\(blurPx)#\(maxPixel)" as NSString
    }

    static func cached(_ url: URL, blurPx: Double = 0, maxPixel: Int) -> UIImage? {
        memory.object(forKey: key(url, blurPx: blurPx, maxPixel: maxPixel))
    }

    /// `blurPx` is at a 390 pt wide screen (scaled to `screen`'s width); the image aspect fills `screen`.
    static func image(_ url: URL, blurPx: Double = 0, maxPixel: Int, screen: CGSize = CGSize(width: 390, height: 844)) async -> UIImage? {
        let cacheKey = key(url, blurPx: blurPx, maxPixel: maxPixel)
        if let hit = memory.object(forKey: cacheKey) { return hit }
        guard let file = try? await ArtCache.shared.localFile(for: url) else { return nil }
        let image = await Task.detached(priority: .utility) { () -> UIImage? in
            guard var cg = ArtDecode.image(at: file, maxPixel: maxPixel) else { return nil }
            if blurPx > 0 {
                // Points to image pixels: aspect fill scales the cover by the screen's long side.
                let points = blurPx * Double(screen.width) / 390
                let sigma = points * Double(max(cg.width, cg.height)) / Double(max(1, max(screen.width, screen.height)))
                cg = ArtDecode.blurred(cg, sigma: sigma) ?? cg
            }
            return UIImage(cgImage: cg)
        }.value
        if let image {
            memory.setObject(image, forKey: cacheKey, cost: Int(image.size.width * image.size.height * 4))
        }
        return image
    }
}

/// The page backdrop for a release (Grilled.md "Player background"): its cover art, aspect filled, lightly
/// blurred under an ink scrim with the scanlines and vignette, crossfading (0.6 s) when the album changes, and
/// the city whenever there is no art (LIT keeps its city).
struct ReleaseBackdrop: View {
    var slug: String?
    var depth: HUDBackdrop.Depth = .page

    @Environment(AppModel.self) private var app
    @State private var loaded: (url: URL, image: UIImage, scrim: Double)?

    private var choice: BackdropChoice { app.backdropChoice(slug: slug) }

    var body: some View {
        ZStack {
            HUDBackdrop(depth: depth)
            if let loaded {
                HUDBackdrop(depth: depth, art: loaded.image, artScrim: loaded.scrim)
                    .id(loaded.url)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.6), value: loaded?.url)
        .task(id: choice) { await load(choice) }
    }

    private func load(_ choice: BackdropChoice) async {
        guard case .art(let url, let blur, let scrim) = choice else {
            loaded = nil
            return
        }
        if loaded?.url == url { return }
        guard let image = await ArtImageLoader.image(url, blurPx: blur, maxPixel: 720, screen: UIScreen.main.bounds.size) else {
            loaded = nil
            return
        }
        loaded = (url, image, scrim)
    }
}

/// The release's cover, unblurred (the sleeve on the release and player pages), for releases without bundled art.
struct CoverArtImage: View {
    let url: URL

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            MSColor.base
            if let image {
                Image(uiImage: image).resizable().scaledToFill().transition(.opacity)
            }
        }
        .task(id: url) {
            image = ArtImageLoader.cached(url, maxPixel: 1024)
            if image == nil { image = await ArtImageLoader.image(url, maxPixel: 1024) }
        }
    }
}
