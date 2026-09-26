import SwiftUI

/// The city behind every native screen, as the player and the site sit on theirs: the LIT street painting
/// (public/assets/images/minidisc/city-comic.webp, pre-blurred into the `CityBackdrop` asset), sunk under an
/// ink scrim (after theme.css `#background-overlay: rgba(7,7,12,0.82)`, see `Depth`), with the gold top glow (theme.css
/// `.bg-glow`), the CRT pass's scanlines and vignette (src/player3d/shaders.ts CRT_PASS: a 2 px line period
/// darkening 14 %, vignette to 55 % at the corners). It drifts slowly (a 48 s loop of a few points); under
/// Reduce Motion it holds still (DS-30).
struct HUDBackdrop: View {
    enum Depth {
        /// Pages: the site's 0.82 ink overlay.
        case page
        /// The full player: the city stays brighter behind the deck, as on the stream page.
        case player

        var scrim: Double {
            switch self {
            // theme.css sinks the site's WebGL city under 0.82; the painting here is already blurred and
            // darker than the live shader scene, so it sits under less to read at the same depth (bar/06).
            case .page: return 0.7
            case .player: return 0.5
            }
        }
    }

    var depth: Depth = .page
    var imageName = "CityBackdrop"
    /// A release's cover, already blurred (ReleaseBackdrop), in place of the city, under its own scrim.
    var art: UIImage? = nil
    var artScrim: Double = DiscDesign.defaultScrim

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// theme.css .bg-glow: `radial-gradient(circle at 50% 0%, rgba(253,185,19,0.07) 0%, transparent 62%)`.
    private static let topGlowAlpha = 0.07
    private static let driftPeriod: TimeInterval = 48
    private static let driftAmplitude: CGFloat = 10
    private static let overscan: CGFloat = 1.08

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                MSColor.ink
                city(size: proxy.size)
                MSColor.ink.opacity(art == nil ? depth.scrim : artScrim)
                RadialGradient(
                    colors: [MSColor.gold.opacity(Self.topGlowAlpha), .clear],
                    center: .top,
                    startRadius: 0,
                    endRadius: max(proxy.size.width, proxy.size.height) * 0.62
                )
                CRTScanlines()
                vignette(size: proxy.size)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func city(size: CGSize) -> some View {
        if reduceMotion {
            cityImage(size: size, offset: .zero)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 20, paused: false)) { timeline in
                let t = timeline.date.timeIntervalSinceReferenceDate / Self.driftPeriod * 2 * .pi
                cityImage(size: size, offset: CGSize(
                    width: CGFloat(sin(t)) * Self.driftAmplitude,
                    height: CGFloat(cos(t * 0.5)) * Self.driftAmplitude * 0.6
                ))
            }
        }
    }

    private func cityImage(size: CGSize, offset: CGSize) -> some View {
        (art.map { Image(uiImage: $0) } ?? Image(imageName))
            .resizable()
            .scaledToFill()
            .frame(width: size.width, height: size.height)
            .scaleEffect(Self.overscan)
            .offset(offset)
            .clipped()
    }

    /// CRT_PASS vignette: `mix(0.55, 1.0, smoothstep(1.05, 0.35, length(dir)))`.
    private func vignette(size: CGSize) -> some View {
        RadialGradient(
            stops: [
                .init(color: .clear, location: 0.35 / 1.05),
                .init(color: MSColor.ink.opacity(0.45), location: 1),
            ],
            center: .center,
            startRadius: 0,
            endRadius: hypot(size.width, size.height) / 2
        )
    }
}

/// CRT_PASS scanlines: `sin(uv.y * PI * res.y / 2)` squared gives a dark line every 2 px, 14 % deep.
struct CRTScanlines: View {
    var depth: Double = 0.14

    var body: some View {
        Canvas(opaque: false, rendersAsynchronously: true) { context, size in
            let pixel = 1 / max(1, context.environment.displayScale)
            var lines = Path()
            var y: CGFloat = 0
            while y < size.height {
                lines.addRect(CGRect(x: 0, y: y, width: size.width, height: pixel))
                y += pixel * 2
            }
            context.fill(lines, with: .color(.black.opacity(depth)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#Preview("HUDBackdrop") {
    HUDBackdrop()
}
