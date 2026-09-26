import SwiftUI

/// DS-22: the deck's calculator-style display, ported from src/player3d/lcd.ts. Amber 14-segment characters
/// behind glass, 11 cells, unlit segments faintly visible (ghost), mode flags (play, pause, stop, repeat)
/// above, segments leaning right 0.12. Every proportion below is lcd.ts's own expression of W and H, so the
/// view draws the same picture at any size; it only redraws when `content` changes (Canvas is diffed on
/// its inputs).
struct LCDView: View {
    var content: LCDContent
    /// The deck window's own proportions (lcd.ts sizes the canvas to the recess); ~5:1 leaves the flags
    /// their full 16 % row. Callers that set an explicit frame can pass `nil`.
    var aspectRatio: CGFloat? = LCDView.defaultAspect

    static let defaultAspect: CGFloat = 1024 / 200

    private typealias Point = CGPoint

    var body: some View {
        Canvas(opaque: true, colorMode: .nonLinear, rendersAsynchronously: false) { context, size in
            draw(in: &context, size: size)
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Display")
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityValue: String {
        var parts = [content.text.trimmingCharacters(in: .whitespaces)]
        if content.play { parts.append("play") }
        if content.pause { parts.append("pause") }
        if content.stop { parts.append("stop") }
        if content.repeat_ { parts.append("repeat") }
        return parts.joined(separator: ", ")
    }

    // MARK: lcd.ts draw()

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let W = size.width
        let H = size.height

        // Bezel, then the dark window with a faint warm wash.
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(MSColor.lcdGlassBezel))
        typealias L = MSComponent.LCD.Layout
        let inset = H * L.insetRatio
        let window = CGRect(x: inset, y: inset, width: W - inset * 2, height: H - inset * 2)
        context.fill(
            Path(roundedRect: window, cornerRadius: H * L.bezelCornerRadiusRatio),
            with: .linearGradient(
                Gradient(colors: [MSColor.lcdGlassWashFrom, MSColor.lcdGlassWashTo]),
                startPoint: CGPoint(x: 0, y: inset),
                endPoint: CGPoint(x: 0, y: H - inset)
            )
        )

        let padX = W * L.padXRatio
        let advance = (W - padX * 2) / CGFloat(LCDGlyphs.characterCount)
        let cw = advance * L.cellWidthRatio
        let ch = cw / MSComponent.LCD.characterAspect
        let baseline = H - inset - H * L.baselineOffsetRatio
        let top = baseline - ch
        let glowRadius = H * L.glowBlurRatio

        // Mode flags above the characters: play, pause, stop, repeat.
        let flagSize = min(H * L.flagMaxSizeRatio, top - inset - H * L.flagYOffsetRatio)
        let flagY = inset + H * L.flagYOffsetRatio
        let flags: [(Bool, (CGFloat) -> [[Point]])] = [
            (content.play, { x in [[Point(x: x, y: flagY), Point(x: x + flagSize * 0.9, y: flagY + flagSize / 2), Point(x: x, y: flagY + flagSize)]] }),
            (content.pause, { x in [
                Self.box(x, flagY, flagSize * 0.3, flagSize),
                Self.box(x + flagSize * 0.55, flagY, flagSize * 0.3, flagSize),
            ] }),
            (content.stop, { x in [Self.box(x, flagY, flagSize * 0.9, flagSize)] }),
            (content.repeat_, { x in Self.repeatIcon(x, flagY, flagSize) }),
        ]
        if flagSize > 0 {
            for (index, flag) in flags.enumerated() {
                for polygon in flag.1(padX + CGFloat(index) * flagSize * L.flagSpacingRatio) {
                    fill(polygon, lit: flag.0, glow: glowRadius, in: &context)
                }
            }
        }

        let (cells, colonsAfter) = LCDGlyphs.layout(content.text)
        var lit = Path()
        // Clock colons in the gap after a cell: two lit dots at a third and two thirds of the character height.
        for index in colonsAfter {
            let gapX = padX + CGFloat(index + 1) * advance + (ch * 0.5) * MSComponent.LCD.italicSlant
            let dot = cw * L.segmentThicknessRatio * 0.95
            for fraction in [CGFloat(0.3), 0.72] {
                let cy = top + ch * fraction
                let x = gapX - dot / 2 + (ch - ch * fraction - ch * 0.5) * MSComponent.LCD.italicSlant
                let polygon = Self.box(x, cy - dot / 2, dot, dot)
                fill(polygon, lit: true, glow: glowRadius, in: &context)
                lit.addLines(polygon)
                lit.closeSubpath()
            }
        }
        for (index, character) in cells.enumerated() {
            let bits = LCDGlyphs.mask(for: character)
            let x = padX + CGFloat(index) * advance + (advance - cw) / 2
            for (segment, polygon) in Self.segmentPolygons(x: x, y: top, cw: cw, ch: ch) {
                let on = bits & segment.bit != 0
                fill(polygon, lit: on, glow: glowRadius, in: &context)
                if on {
                    lit.addLines(polygon)
                    lit.closeSubpath()
                }
            }
        }
        bloom(lit, height: H, in: &context)
    }

    /// The deck LCD sits under the scene's UnrealBloomPass (src/player3d/scene.ts: strength 0.5, radius
    /// 0.55): a wide, faint amber halo over the lit characters on top of lcd.ts's own tight glow.
    private func bloom(_ lit: Path, height H: CGFloat, in context: inout GraphicsContext) {
        guard !lit.isEmpty else { return }
        context.drawLayer { layer in
            layer.addFilter(.blur(radius: H * Self.bloomRadiusRatio))
            layer.blendMode = .plusLighter
            layer.fill(lit, with: .color(MSColor.lcdGlow.opacity(Self.bloomStrength)))
        }
    }

    static let bloomRadiusRatio: CGFloat = 0.16
    static let bloomStrength: Double = 0.5

    /// lcd.ts fillPolygon: lit segments glow (`shadowColor rgba(255,160,20,0.9)`, blur `H * 0.045`), unlit
    /// ones sit at the ghost tint.
    private func fill(_ points: [Point], lit: Bool, glow: CGFloat, in context: inout GraphicsContext) {
        var path = Path()
        path.addLines(points)
        path.closeSubpath()
        if lit {
            context.drawLayer { layer in
                layer.addFilter(.shadow(color: MSColor.lcdGlow, radius: glow, x: 0, y: 0))
                layer.fill(path, with: .color(MSColor.lcdLit))
            }
        } else {
            context.fill(path, with: .color(MSColor.lcdGhost))
        }
    }

    private static func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> [Point] {
        [Point(x: x, y: y), Point(x: x + w, y: y), Point(x: x + w, y: y + h), Point(x: x, y: y + h)]
    }

    /// lcd.ts repeatIcon: a ring with a gap and an arrowhead.
    private static func repeatIcon(_ x: CGFloat, _ y: CGFloat, _ size: CGFloat) -> [[Point]] {
        let cx = x + size / 2
        let cy = y + size / 2
        let outer = size / 2
        let inner = outer * 0.62
        var ring: [Point] = []
        let from = -CGFloat.pi * 0.35
        let to = CGFloat.pi * 1.35
        for i in 0...18 {
            let a = from + (to - from) * CGFloat(i) / 18
            ring.append(Point(x: cx + cos(a) * outer, y: cy + sin(a) * outer))
        }
        for i in stride(from: 18, through: 0, by: -1) {
            let a = from + (to - from) * CGFloat(i) / 18
            ring.append(Point(x: cx + cos(a) * inner, y: cy + sin(a) * inner))
        }
        let mid = (outer + inner) / 2
        let base = Point(x: cx + cos(from) * mid, y: cy + sin(from) * mid)
        let arrow: [Point] = [
            Point(x: base.x - size * 0.26, y: base.y - size * 0.04),
            Point(x: base.x + size * 0.2, y: base.y - size * 0.2),
            Point(x: base.x + size * 0.02, y: base.y + size * 0.26),
        ]
        return [ring, arrow]
    }

    /// lcd.ts segmentPolygons: one character's 14 segments as slanted polygons.
    private static func segmentPolygons(x: CGFloat, y: CGFloat, cw: CGFloat, ch: CGFloat) -> [(LCDSegment, [Point])] {
        typealias L = MSComponent.LCD.Layout
        let t = cw * L.segmentThicknessRatio
        let g = t * L.segmentGapRatio
        let left = t / 2
        let right = cw - t / 2
        let centre = cw / 2
        let topY = t / 2
        let mid = ch / 2
        let bottom = ch - t / 2

        func horizontal(_ x1: CGFloat, _ x2: CGFloat, _ yy: CGFloat) -> [Point] {
            [
                Point(x: x1, y: yy),
                Point(x: x1 + t / 2, y: yy - t / 2),
                Point(x: x2 - t / 2, y: yy - t / 2),
                Point(x: x2, y: yy),
                Point(x: x2 - t / 2, y: yy + t / 2),
                Point(x: x1 + t / 2, y: yy + t / 2),
            ]
        }
        func vertical(_ xx: CGFloat, _ y1: CGFloat, _ y2: CGFloat) -> [Point] {
            [
                Point(x: xx, y: y1),
                Point(x: xx + t / 2, y: y1 + t / 2),
                Point(x: xx + t / 2, y: y2 - t / 2),
                Point(x: xx, y: y2),
                Point(x: xx - t / 2, y: y2 - t / 2),
                Point(x: xx - t / 2, y: y1 + t / 2),
            ]
        }
        func diagonal(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) -> [Point] {
            let length = hypot(x2 - x1, y2 - y1)
            let nx = (-(y2 - y1) / length) * t * L.diagonalNormalRatio
            let ny = ((x2 - x1) / length) * t * L.diagonalNormalRatio
            return [
                Point(x: x1 + nx, y: y1 + ny),
                Point(x: x2 + nx, y: y2 + ny),
                Point(x: x2 - nx, y: y2 - ny),
                Point(x: x1 - nx, y: y1 - ny),
            ]
        }
        let d = t * L.diagonalOffsetRatio
        let segments: [(LCDSegment, [Point])] = [
            (.a, horizontal(left + g, right - g, topY)),
            (.d, horizontal(left + g, right - g, bottom)),
            (.g1, horizontal(left + g, centre - g, mid)),
            (.g2, horizontal(centre + g, right - g, mid)),
            (.f, vertical(left, topY + g, mid - g)),
            (.e, vertical(left, mid + g, bottom - g)),
            (.b, vertical(right, topY + g, mid - g)),
            (.c, vertical(right, mid + g, bottom - g)),
            (.i, vertical(centre, topY + g, mid - g)),
            (.l, vertical(centre, mid + g, bottom - g)),
            (.h, diagonal(left + d, topY + d, centre - d * 0.5, mid - d * 0.5)),
            (.j, diagonal(right - d, topY + d, centre + d * 0.5, mid - d * 0.5)),
            (.k, diagonal(centre - d * 0.5, mid + d * 0.5, left + d, bottom - d)),
            (.m, diagonal(centre + d * 0.5, mid + d * 0.5, right - d, bottom - d)),
        ]
        // Into place, leaning right.
        let slant = MSComponent.LCD.italicSlant
        return segments.map { name, points in
            (name, points.map { p in Point(x: x + p.x + (ch - p.y) * slant, y: y + p.y) })
        }
    }
}

#Preview("LCDView") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        VStack(spacing: 12) {
            LCDView(content: .playing(track: 1))
            LCDView(content: .loading)
            LCDView(content: .edition(7))
        }
        .padding()
    }
}
