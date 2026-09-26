import MyindWear
import SwiftUI

/// The printed card sleeves the rack shows (the same art the 3D sleeve prints: `lit-sleeve.webp` for LIT).
enum RackArt {
    static func sleeveName(for slug: String) -> String? {
        switch slug {
        case "lit": return "LITSleeve"
        case "c-walk", "cwalk": return "CWalkSleeve"
        case "the-source": return "TheSourceSleeve"
        default: return nil
        }
    }

    /// The sleeve is a touch taller than wide once the cartridge's top edge stands proud of the mouth.
    static let cartridgeLip: CGFloat = 0.075
    static var aspect: CGFloat { 1 / (1 + cartridgeLip) }
    /// A rack with rendered discs: taller tiles, so the cartridge standing out of the sleeve has room and the
    /// sleeve still spans most of the tile. Printed sleeves sit at the foot of the same box, so rows line up.
    static let renderAspect: CGFloat = 0.8
}

/// One copy on the rack (RACK-1): the printed card sleeve, the clear cartridge just proud of its mouth, a soft
/// shadow, the copy's wear as a faint scuff (proportional to its level, WEAR-1: the same seed always scuffs the
/// same way), die-cut stickers, a loan tag, and for a locked release the shrink film (DROP-2).
/// Everything is drawn relative to the view's size, so it scales smoothly through the shared-element move.
struct SleeveArt: View {
    let slug: String
    let title: String
    var edition: Int?
    var stickers: [RackSticker] = []
    var state: RackTileState = .owned
    var wear: WearDescriptor?
    var accent: Color = MSColor.gold

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let lip = width * RackArt.cartridgeLip
            VStack(spacing: 0) {
                CartridgeEdge()
                    .frame(width: width * 0.9, height: lip * 1.6)
                    .offset(y: lip * 0.6)
                    .zIndex(0)
                face(side: width)
                    .frame(width: width, height: width)
                    .zIndex(1)
            }
            .frame(width: width, height: proxy.size.height, alignment: .bottom)
        }
        .aspectRatio(RackArt.aspect, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private func face(side: CGFloat) -> some View {
        ZStack {
            printed(side: side)
            // Rubbed card edge and a little light across the print.
            LinearGradient(colors: [.white.opacity(0.1), .clear, .black.opacity(0.18)], startPoint: .topLeading, endPoint: .bottomTrailing)
            SleeveFaceOverlays(
                slug: slug, edition: edition, stickers: stickers, state: state, wear: wear, generic: RackArt.sleeveName(for: slug) == nil
            )
        }
        .frame(width: side, height: side)
        .clipShape(Rectangle())
        .overlay(Rectangle().strokeBorder(Color.black.opacity(0.5), lineWidth: 0.5))
        // DS-20: floats on the ink with a soft shadow.
        .shadow(color: .black.opacity(0.55), radius: side * 0.07, x: 0, y: side * 0.045)
    }

    @ViewBuilder
    private func printed(side: CGFloat) -> some View {
        if let name = RackArt.sleeveName(for: slug) {
            Image(name).resizable().scaledToFill().frame(width: side, height: side).clipped()
        } else {
            GenericSleeve(title: title, accent: accent, side: side)
        }
    }
}

/// What sits on a sleeve's face over the print or the render: the copy's wear, the loan tag, die-cut stickers
/// and, for a locked release, the shrink film (DROP-2). Laid out on a square face `side` points wide.
struct SleeveFaceOverlays: View {
    let slug: String
    var edition: Int?
    var stickers: [RackSticker]
    var state: RackTileState
    var wear: WearDescriptor?
    /// A sleeve without art prints its title across the top, so its stickers sit below it.
    var generic: Bool

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                if let wear, wear.level > 0 {
                    WearScuffs(descriptor: wear).allowsHitTesting(false)
                }
                if let lines = state.tagLines {
                    LoanTag(lines: lines, side: side)
                }
                ForEach(Array(stickers.enumerated()), id: \.element) { slot, sticker in
                    let centre = RackRules.stickerCentre(
                        slug: slug, edition: edition, slot: slot, tagged: state.tagLines != nil, generic: generic
                    )
                    VinylSticker(sticker: sticker, diameter: side * 0.27)
                        .rotationEffect(.degrees(RackRules.stickerAngle(slug: slug, edition: edition, slot: slot)))
                        .position(x: side * centre.x, y: side * centre.y)
                }
                if state.isLocked {
                    ShrinkFilm()
                }
            }
            .frame(width: side, height: side)
        }
        .allowsHitTesting(false)
    }
}

/// The clear MiniDisc shell's top edge, standing just proud of the sleeve's mouth.
private struct CartridgeEdge: View {
    var body: some View {
        GeometryReader { proxy in
            let h = proxy.size.height
            ZStack(alignment: .top) {
                UnevenRoundedRectangle(topLeadingRadius: h * 0.45, topTrailingRadius: h * 0.45)
                    .fill(LinearGradient(
                        colors: [Color(white: 0.86).opacity(0.55), Color(white: 0.55).opacity(0.3), Color(white: 0.2).opacity(0.5)],
                        startPoint: .top, endPoint: .bottom
                    ))
                UnevenRoundedRectangle(topLeadingRadius: h * 0.45, topTrailingRadius: h * 0.45)
                    .strokeBorder(Color.white.opacity(0.45), lineWidth: max(0.5, h * 0.05))
                // The two screws at the top corners of the shell.
                HStack {
                    Circle().fill(Color(white: 0.75)).frame(width: h * 0.26)
                    Spacer()
                    Circle().fill(Color(white: 0.75)).frame(width: h * 0.26)
                }
                .padding(.horizontal, h * 0.45)
                .padding(.top, h * 0.18)
            }
        }
    }
}

/// A release without bundled art: an ink card with the title, the imprint and the release accent.
private struct GenericSleeve: View {
    let title: String
    let accent: Color
    let side: CGFloat

    var body: some View {
        // The title across the top, clear of the loan tag and the stickers below it.
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [Color(red: 0.14, green: 0.11, blue: 0.16), MSColor.ink], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [accent.opacity(0.35), .clear], center: .topTrailing, startRadius: 0, endRadius: side * 0.9)
            VStack(alignment: .leading, spacing: side * 0.02) {
                Text(title.uppercased())
                    .font(MSFont.inter(side * 0.15, weight: .extrabold))
                    .foregroundStyle(MSColor.text)
                    .lineLimit(2)
                    .minimumScaleFactor(0.5)
                Rectangle().fill(accent).frame(width: side * 0.22, height: max(1, side * 0.012))
                Text("THA MYIND · MYIND SOUND")
                    .font(MSFont.mono(side * 0.045, weight: .semibold))
                    .foregroundStyle(MSColor.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .padding(side * 0.09)
        }
        .frame(width: side, height: side)
    }
}

/// The copy's wear on the card (PRD 11.4 is the contract, not the look): the descriptor's scratches as fine pale
/// strokes and its scuff zones as rubbed patches, all faint, so the art always reads (WEAR-4).
private struct WearScuffs: View {
    let descriptor: WearDescriptor

    var body: some View {
        Canvas { context, size in
            let w = size.width, h = size.height
            for zone in descriptor.scuffZones {
                let r: CGFloat = CGFloat(zone.radius) * w * 1.4
                let rect = CGRect(x: CGFloat(zone.x) * w - r, y: CGFloat(zone.y) * h - r, width: r * 2, height: r * 2)
                let tint = Color(white: 0.95).opacity(0.1 * zone.intensity)
                let shading = GraphicsContext.Shading.radialGradient(
                    Gradient(colors: [tint, .clear]), center: CGPoint(x: rect.midX, y: rect.midY), startRadius: 0, endRadius: r
                )
                context.fill(Path(ellipseIn: rect), with: shading)
            }
            for scratch in descriptor.scratches {
                let angle = CGFloat(scratch.angle * .pi / 180)
                let length = CGFloat(scratch.length) * w * 0.8
                let dx: CGFloat = Foundation.cos(angle) * length
                let dy: CGFloat = Foundation.sin(angle) * length
                let start = CGPoint(x: CGFloat(scratch.x) * w - dx / 2, y: CGFloat(scratch.y) * h - dy / 2)
                var path = Path()
                path.move(to: start)
                path.addLine(to: CGPoint(x: start.x + dx, y: start.y + dy))
                let alpha = 0.1 + 0.22 * scratch.depth
                context.stroke(path, with: .color(Color(white: 0.96).opacity(alpha)), lineWidth: max(0.4, w * 0.003))
            }
            // Rubbed corners and edges.
            let edge = descriptor.edgeWear
            if edge > 0 {
                context.stroke(Path(CGRect(origin: .zero, size: size).insetBy(dx: w * 0.01, dy: w * 0.01)),
                               with: .color(Color(white: 0.9).opacity(0.18 * edge)), lineWidth: w * 0.02)
            }
        }
        .blendMode(.screen)
    }
}

/// A die-cut vinyl sticker: its shape in the brand palette, a white paper edge round it, and a slight gloss.
struct VinylSticker: View {
    let sticker: RackSticker
    let diameter: CGFloat

    var body: some View {
        let shape = StickerShape(kind: sticker)
        ZStack {
            // The white paper the sticker was cut from, a little wider than the print.
            shape.fill(Color(white: 0.97))
                .frame(width: diameter, height: diameter)
                .shadow(color: .black.opacity(0.45), radius: diameter * 0.04, x: 0, y: diameter * 0.03)
            shape.fill(fill)
                .frame(width: diameter * 0.86, height: diameter * 0.86)
            label
            // Gloss: light caught across the top of the vinyl.
            shape.fill(LinearGradient(colors: [.white.opacity(0.45), .white.opacity(0.05), .clear],
                                      startPoint: .topLeading, endPoint: .center))
                .frame(width: diameter * 0.86, height: diameter * 0.86)
                .blendMode(.screen)
        }
        .frame(width: diameter, height: diameter)
    }

    private var fill: AnyShapeStyle {
        switch sticker {
        case .top20: return AnyShapeStyle(MSColor.gold)
        case .first100: return AnyShapeStyle(MSColor.orange)
        case .tier(let tier): return AnyShapeStyle(LinearGradient(colors: Self.metal(tier), startPoint: .top, endPoint: .bottom))
        }
    }

    /// Tier metals, lit from above.
    static func metal(_ tier: String) -> [Color] {
        switch tier {
        case "gold": return [Color(red: 1, green: 0.86, blue: 0.4), MSColor.gold, Color(red: 0.72, green: 0.5, blue: 0.02)]
        case "silver": return [Color(white: 0.95), Color(white: 0.76), Color(white: 0.55)]
        default: return [Color(red: 0.93, green: 0.66, blue: 0.43), Color(red: 0.76, green: 0.47, blue: 0.24), Color(red: 0.5, green: 0.28, blue: 0.12)]
        }
    }

    @ViewBuilder
    private var label: some View {
        let ink = MSColor.ink
        switch sticker {
        case .top20:
            VStack(spacing: -diameter * 0.04) {
                Text("TOP").font(MSFont.mono(diameter * 0.15, weight: .bold))
                Text("20").font(MSFont.inter(diameter * 0.34, weight: .extrabold))
            }
            .foregroundStyle(ink)
        case .first100:
            VStack(spacing: -diameter * 0.03) {
                Text("FIRST").font(MSFont.mono(diameter * 0.13, weight: .bold))
                Text("100").font(MSFont.inter(diameter * 0.26, weight: .extrabold))
            }
            .foregroundStyle(ink)
        case .tier(let tier):
            VStack(spacing: diameter * 0.01) {
                Image(systemName: "star.fill").font(.system(size: diameter * 0.14, weight: .bold))
                Text(tier.uppercased()).font(MSFont.mono(diameter * 0.12, weight: .bold))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
            }
            .foregroundStyle(ink.opacity(0.85))
            .padding(.horizontal, diameter * 0.12)
        }
    }
}

/// TOP 20 is a round dot, FIRST 100 a starburst, the collector tier a hexagon badge.
struct StickerShape: Shape {
    let kind: RackSticker

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        switch kind {
        case .top20:
            return Path(ellipseIn: rect)
        case .first100:
            var path = Path()
            let points = 16
            for i in 0..<(points * 2) {
                let a = CGFloat(i) * .pi / CGFloat(points) - .pi / 2
                let radius: CGFloat = i.isMultiple(of: 2) ? r : r * 0.84
                let p = CGPoint(x: c.x + Foundation.cos(a) * radius, y: c.y + Foundation.sin(a) * radius)
                i == 0 ? path.move(to: p) : path.addLine(to: p)
            }
            path.closeSubpath()
            return path
        case .tier:
            var path = Path()
            for i in 0..<6 {
                let a = CGFloat(i) * .pi / 3 - .pi / 2
                let p = CGPoint(x: c.x + Foundation.cos(a) * r, y: c.y + Foundation.sin(a) * r)
                i == 0 ? path.move(to: p) : path.addLine(to: p)
            }
            path.closeSubpath()
            return path
        }
    }
}

/// ON LOAN / FROM <lender>: a band across the sleeve's foot, like a library card slipped under the film.
private struct LoanTag: View {
    let lines: (String, String)
    let side: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: side * 0.012) {
                Text(lines.0)
                    .font(MSFont.mono(side * 0.075, weight: .bold))
                    .foregroundStyle(MSColor.gold)
                Text(lines.1)
                    .font(MSFont.mono(side * 0.062, weight: .semibold))
                    .foregroundStyle(MSColor.orange)
                    .monospacedDigit()
            }
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .padding(.horizontal, side * 0.06)
            .padding(.vertical, side * 0.035)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MSColor.ink.opacity(0.84))
            .overlay(alignment: .top) { Rectangle().fill(MSColor.line).frame(height: max(0.5, side * 0.006)) }
        }
    }
}

/// Clear shrink film over a sealed sleeve (DROP-2): a cool tint, two glossy streaks and a few creases.
private struct ShrinkFilm: View {
    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height
            ZStack {
                Color(red: 0.78, green: 0.82, blue: 0.88).opacity(0.16)
                LinearGradient(stops: [
                    .init(color: .clear, location: 0.18),
                    .init(color: .white.opacity(0.42), location: 0.26),
                    .init(color: .clear, location: 0.36),
                    .init(color: .clear, location: 0.6),
                    .init(color: .white.opacity(0.22), location: 0.66),
                    .init(color: .clear, location: 0.72),
                ], startPoint: .topLeading, endPoint: .bottomTrailing)
                Canvas { context, _ in
                    let creases: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
                        (0.05, 0.12, 0.34, 0.02), (0.62, 0.95, 0.98, 0.7), (0.0, 0.7, 0.2, 0.98), (0.7, 0.04, 0.96, 0.22),
                    ]
                    for (x1, y1, x2, y2) in creases {
                        var p = Path()
                        p.move(to: CGPoint(x: x1 * w, y: y1 * h))
                        p.addQuadCurve(to: CGPoint(x: x2 * w, y: y2 * h), control: CGPoint(x: (x1 + x2) / 2 * w + w * 0.04, y: (y1 + y2) / 2 * h))
                        context.stroke(p, with: .color(.white.opacity(0.28)), lineWidth: max(0.5, w * 0.005))
                    }
                }
                Rectangle().strokeBorder(Color.white.opacity(0.35), lineWidth: max(0.5, w * 0.008))
            }
            .blendMode(.screen)
        }
        .allowsHitTesting(false)
    }
}
