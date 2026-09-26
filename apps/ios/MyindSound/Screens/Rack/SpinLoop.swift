import MyindWear
import QuartzCore
import SwiftUI
import UIKit

/// A decoded spin loop: every frame cut out of the sheet once and trimmed to the pixels the cartridge covers
/// (the union over all frames, so the loop never jitters), as small independent CGImages.
final class SpinFrames {
    let frames: [CGImage]
    let fps: Double
    /// Width over height of the trimmed frames.
    let aspect: CGFloat

    init(frames: [CGImage], fps: Double) {
        self.frames = frames
        self.fps = fps
        let first = frames.first
        self.aspect = first.map { CGFloat($0.width) / CGFloat(max(1, $0.height)) } ?? 1
    }

    var cost: Int { frames.reduce(0) { $0 + $1.bytesPerRow * $1.height } }
}

/// Loads and slices spin loops (off the main thread), with an in-memory cache over the disk cache.
enum SpinLoopLoader {
    /// Frames are decoded for a tile about this many pixels wide (a third of a phone at 3x, with room for the
    /// focus lift). Sheets are downsampled to it before slicing, so a 3072 px sheet never sits in memory.
    static let framePixels = 384

    private static let memory: NSCache<NSString, SpinFrames> = {
        let cache = NSCache<NSString, SpinFrames>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()

    static func cached(_ url: URL) -> SpinFrames? { memory.object(forKey: url.absoluteString as NSString) }

    /// The loop's frames, or nil when the sheet can't be had or came out blank.
    static func frames(for render: RackRender) async -> SpinFrames? {
        if let hit = cached(render.spriteURL) { return hit }
        // The published sheet (WebP by default), then the PNG of the same layout.
        for url in [render.spriteURL, render.pngURL].compactMap({ $0 }) {
            guard let file = try? await ArtCache.shared.localFile(for: url),
                  let result = await Task.detached(priority: .utility, operation: { slice(file: file, meta: render.meta) }).value
            else { continue }
            memory.setObject(result, forKey: render.spriteURL.absoluteString as NSString, cost: result.cost)
            return result
        }
        return nil
    }

    /// The still (`rack.stillUrl`), trimmed the same way: Reduce Motion, sealed copies, and the fallback.
    static func still(for render: RackRender) async -> SpinFrames? {
        guard let url = render.stillURL else { return nil }
        if let hit = cached(url) { return hit }
        guard let file = try? await ArtCache.shared.localFile(for: url) else { return nil }
        let result = await Task.detached(priority: .utility) { () -> SpinFrames? in
            guard let image = ArtDecode.image(at: file, maxPixel: framePixels * 2), let bitmap = ArtDecode.bitmap(image) else { return nil }
            let full = CGRect(x: 0, y: 0, width: image.width, height: image.height)
            guard let box = opaqueBounds(bitmap, cells: [full]), let frame = copy(bitmap, rect: box) else { return nil }
            return SpinFrames(frames: [frame], fps: 1)
        }.value
        if let result { memory.setObject(result, forKey: url.absoluteString as NSString, cost: result.cost) }
        return result
    }

    /// Decode (downsampled), cut every cell (`SpriteSheet`), trim to the union of their opaque pixels.
    static func slice(file: URL, meta: SpriteMeta, framePixels: Int = framePixels) -> SpinFrames? {
        let scale = min(1, Double(framePixels) / Double(max(meta.frameW, meta.frameH)))
        let maxSide = Int((Double(max(meta.sheetW, meta.sheetH)) * scale).rounded(.up))
        guard let sheet = ArtDecode.image(at: file, maxPixel: scale < 1 ? maxSide : nil),
              let bitmap = ArtDecode.bitmap(sheet) else { return nil }
        let cells = SpriteSheet.cells(meta: meta, pixelWidth: sheet.width, pixelHeight: sheet.height)
        guard cells.count == meta.frames, let trim = opaqueBounds(bitmap, cells: cells, relative: true) else { return nil }
        var frames: [CGImage] = []
        frames.reserveCapacity(cells.count)
        for cell in cells {
            let rect = CGRect(x: cell.minX + trim.minX, y: cell.minY + trim.minY, width: trim.width, height: trim.height)
                .intersection(cell)
            guard let frame = copy(bitmap, rect: rect.integral) else { return nil }
            frames.append(frame)
        }
        return SpinFrames(frames: frames, fps: meta.fps)
    }

    /// The bounding box of pixels with visible alpha, unioned over `cells` (relative to each cell's origin when
    /// `relative`), with a pixel of margin. Nil when every cell is empty (a failed render).
    static func opaqueBounds(_ bitmap: CGContext, cells: [CGRect], relative: Bool = false) -> CGRect? {
        guard let data = bitmap.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        let bytesPerRow = bitmap.bytesPerRow
        var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        for cell in cells {
            let x0 = Int(cell.minX), y0 = Int(cell.minY), x1 = Int(cell.maxX), y1 = Int(cell.maxY)
            // Every other pixel is enough for a box (the margin covers the skipped one).
            var y = y0
            while y < y1 {
                let row = data + y * bytesPerRow
                var x = x0
                while x < x1 {
                    if row[x * 4 + 3] > 10 {
                        let lx = relative ? x - x0 : x, ly = relative ? y - y0 : y
                        if lx < minX { minX = lx }
                        if lx > maxX { maxX = lx }
                        if ly < minY { minY = ly }
                        if ly > maxY { maxY = ly }
                    }
                    x += 2
                }
                y += 2
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(x: max(0, minX - 2), y: max(0, minY - 2), width: maxX - minX + 5, height: maxY - minY + 5)
    }

    /// An independent copy of `rect` (bitmap coordinates, top left origin), so the big sheet can be freed.
    private static func copy(_ bitmap: CGContext, rect: CGRect) -> CGImage? {
        guard let whole = bitmap.makeImage(), let cropped = whole.cropping(to: rect),
              let context = CGContext(
                  data: nil, width: cropped.width, height: cropped.height, bitsPerComponent: 8, bytesPerRow: cropped.width * 4,
                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: cropped.width, height: cropped.height))
        return context.makeImage()
    }
}

/// Plays a spin loop by stepping a layer's contents on a CADisplayLink at the loop's own fps. It stops when the
/// view leaves the window, drops to a slow visibility poll while scrolled off screen, and stops while the app is
/// in the background or `animating` is off (Reduce Motion, a sealed copy): then it holds `stillFrame`.
final class SpinLoopUIView: UIView {
    var frames: SpinFrames? { didSet { if frames !== oldValue { shown = -1; update() } } }
    var stillFrame: CGImage? { didSet { if stillFrame !== oldValue { shown = -1; update() } } }
    var animating = true { didSet { if animating != oldValue { update() } } }
    /// Seconds added to the clock, so neighbouring discs don't turn in step.
    var phase: TimeInterval = 0

    private var link: CADisplayLink?
    private var shown = -1
    private var active = UIApplication.shared.applicationState != .background
    private var polling = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.contentsGravity = .resizeAspect
        layer.magnificationFilter = .linear
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit { link?.invalidate() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    @objc private func background() { active = false; update() }
    @objc private func foreground() { active = true; update() }

    private var shouldRun: Bool {
        animating && active && window != nil && (frames?.frames.count ?? 0) > 1
    }

    private func update() {
        if shouldRun {
            startLink()
            tick()
        } else {
            stopLink()
            showStill()
        }
    }

    private func showStill() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = stillFrame ?? frames?.frames.first
        CATransaction.commit()
        shown = -1
    }

    private func startLink() {
        guard link == nil else { return }
        let link = CADisplayLink(target: WeakTarget(self), selector: #selector(WeakTarget.tick))
        setRate(link, poll: false)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
        polling = false
    }

    private func setRate(_ link: CADisplayLink, poll: Bool) {
        let fps = Float(poll ? 4 : min(60, max(1, frames?.fps ?? 24)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: fps, maximum: fps, preferred: fps)
        polling = poll
    }

    fileprivate func tick() {
        guard let frames, let window, let link else { return }
        // Off screen (scrolled away, or under another page): poll slowly instead of drawing.
        let visible = !isHidden && window.bounds.intersects(convert(bounds, to: window))
        if visible == polling { setRate(link, poll: !visible) }
        guard visible else { return }
        let index = SpriteSheet.frameIndex(at: CACurrentMediaTime() + phase, frames: frames.frames.count, fps: frames.fps)
        guard index != shown else { return }
        shown = index
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = frames.frames[index]
        CATransaction.commit()
    }

    /// CADisplayLink retains its target; this breaks the cycle.
    private final class WeakTarget {
        weak var view: SpinLoopUIView?
        init(_ view: SpinLoopUIView) { self.view = view }
        @objc func tick() { view?.tick() }
    }
}

/// SwiftUI wrapper for the player layer.
struct SpinLoopPlayer: UIViewRepresentable {
    var frames: SpinFrames?
    var still: CGImage?
    var animating: Bool
    var phase: TimeInterval = 0

    func makeUIView(context: Context) -> SpinLoopUIView {
        let view = SpinLoopUIView(frame: .zero)
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: SpinLoopUIView, context: Context) {
        view.phase = phase
        view.frames = frames
        view.stillFrame = still
        view.animating = animating
    }
}

/// A copy on the rack as its real render (RACK-1 with generated discs): the sleeved cartridge with the disc
/// turning inside the casing, over which the stickers, the loan tag, the wear and the shrink film sit on the
/// sleeve's face. Until the loop has loaded it shows the still, else the printed placeholder sleeve.
struct RenderedSleeve: View {
    let release: LibraryRelease
    let render: RackRender
    let state: RackTileState
    var edition: Int?
    var stickers: [RackSticker]
    var wear: WearDescriptor?
    var accent: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var frames: SpinFrames?
    @State private var still: SpinFrames?
    @State private var failed = false

    /// Sealed copies don't turn (DROP-2: not playable yet).
    private var holdsStill: Bool { reduceMotion || state.isLocked }
    private var display: SpinFrames? { holdsStill ? (still ?? frames) : (frames ?? still) }

    var body: some View {
        GeometryReader { proxy in
            let box = proxy.size
            if let display {
                let aspect = display.aspect
                // Fit, bottom aligned: the sleeve's foot sits where a printed sleeve's would.
                let height = min(box.height, box.width / aspect)
                let width = height * aspect
                let face = RackRules.renderFace(width: width, height: height)
                ZStack(alignment: .topLeading) {
                    SpinLoopPlayer(
                        frames: holdsStill ? nil : frames,
                        // The still holds for Reduce Motion and sealed copies, and stands in for a loop that failed.
                        still: holdsStill || frames == nil ? display.frames.first : nil,
                        animating: !holdsStill && frames != nil && scenePhase == .active,
                        phase: RackRules.loopPhase(slug: release.slug)
                    )
                    .frame(width: width, height: height)
                    .shadow(color: .black.opacity(0.5), radius: width * 0.05, x: 0, y: width * 0.035)
                    SleeveFaceOverlays(
                        slug: release.slug, edition: edition, stickers: stickers, state: state, wear: wear, generic: false
                    )
                    .frame(width: face.width, height: face.height)
                    .offset(x: face.minX, y: face.minY)
                }
                .frame(width: width, height: height)
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
        frames = SpinLoopLoader.cached(render.spriteURL)
        async let loop = SpinLoopLoader.frames(for: render)
        async let picture = SpinLoopLoader.still(for: render)
        let (f, s) = await (loop, picture)
        frames = f
        still = s
        failed = f == nil && s == nil
    }
}
