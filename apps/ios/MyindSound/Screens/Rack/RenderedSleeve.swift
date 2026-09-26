import MyindWear
import SwiftUI
import UIKit

/// Loads rack stills (`rack.stillWebpUrl`, else `stillUrl`), decoded off the main thread at tile size, with an
/// in-memory cache over the disk cache (ArtCache).
enum RackStillLoader {
    /// Decoded for a tile about this many pixels wide, with room for the focus lift (the 3D sleeve takes over there).
    static let maxPixels = 900

    private static let memory: NSCache<NSString, CGImageBox> = {
        let cache = NSCache<NSString, CGImageBox>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    final class CGImageBox {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    static func cached(_ render: RackRender) -> CGImage? {
        memory.object(forKey: render.stillURL.absoluteString as NSString)?.image
    }

    /// The still, or nil when neither file can be had or decoded (the printed sleeve stands in).
    static func image(for render: RackRender) async -> CGImage? {
        if let hit = cached(render) { return hit }
        for url in render.candidates {
            guard let file = try? await ArtCache.shared.localFile(for: url),
                  let image = await Task.detached(priority: .utility, operation: { decode(file: file) }).value
            else { continue }
            memory.setObject(CGImageBox(image), forKey: render.stillURL.absoluteString as NSString, cost: image.bytesPerRow * image.height)
            return image
        }
        return nil
    }

    /// Decoded (downsampled to `maxPixels`); nil when the file isn't an image or has nothing in it.
    static func decode(file: URL, maxPixels: Int = maxPixels) -> CGImage? {
        guard let image = ArtDecode.image(at: file, maxPixel: maxPixels), image.width > 0, image.height > 0 else { return nil }
        return image
    }
}

/// A copy on the rack as its real render (RACK-1): the release in its printed sleeve, the disc inside, one still
/// 3D render (`renderSleeveStill`), completely still. Over the sleeve's printed front (`RackStill.face`) sit the
/// copy's wear, stickers, the loan tag and, for a sealed release, the shrink film. Until the still has loaded the
/// printed sleeve shows, faintly.
struct RenderedSleeve: View {
    let release: LibraryRelease
    let render: RackRender
    let state: RackTileState
    var edition: Int?
    var stickers: [RackSticker]
    var wear: WearDescriptor?
    var accent: Color

    @State private var image: CGImage?
    @State private var failed = false

    init(release: LibraryRelease, render: RackRender, state: RackTileState, edition: Int?, stickers: [RackSticker],
         wear: WearDescriptor?, accent: Color) {
        self.release = release
        self.render = render
        self.state = state
        self.edition = edition
        self.stickers = stickers
        self.wear = wear
        self.accent = accent
        // Already decoded (scrolled back, or the focus view's copy of the tile): no placeholder frame.
        _image = State(initialValue: RackStillLoader.cached(render))
    }

    var body: some View {
        GeometryReader { proxy in
            let box = proxy.size
            if let image {
                // Square, fitted, bottom aligned: the sleeve's foot sits where a printed sleeve's would.
                let side = min(box.width, box.height)
                let face = RackStill.face(side: side)
                ZStack(alignment: .topLeading) {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: side, height: side)
                    SleeveFaceOverlays(
                        slug: release.slug, edition: edition, stickers: stickers, state: state, wear: wear, generic: false
                    )
                    .frame(width: face.width, height: face.height)
                    .offset(x: face.minX, y: face.minY)
                }
                .frame(width: side, height: side)
                .frame(width: box.width, height: box.height, alignment: .bottom)
            } else {
                SleeveArt(slug: release.slug, title: release.title, edition: edition, stickers: stickers, state: state,
                          wear: wear, accent: accent)
                    .frame(width: box.width, height: box.height, alignment: .bottom)
                    .opacity(failed ? 1 : 0.35)
            }
        }
        .accessibilityHidden(true)
        .task(id: render) { await load() }
    }

    private func load() async {
        if let hit = RackStillLoader.cached(render) {
            image = hit
            return
        }
        let loaded = await RackStillLoader.image(for: render)
        image = loaded
        failed = loaded == nil
    }
}
