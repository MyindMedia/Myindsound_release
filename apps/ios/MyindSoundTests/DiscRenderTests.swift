import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import MyindSound

/// Generated discs: the spin-loop sheet maths (packages/minidisc/src/sprite.ts layout), the library's new
/// `design` / `rack` / `bundle` fields (LIT has none), and which backdrop a release gets. Values are made up.
final class DiscRenderTests: XCTestCase {
    private let meta36 = SpriteMeta(frames: 36, cols: 6, rows: 6, frameW: 512, frameH: 512, sheetW: 3072, sheetH: 3072, fps: 24)

    // MARK: Sprite sheet slicing

    func testCellsAreRowMajorWithNoPadding() {
        XCTAssertEqual(SpriteSheet.cell(0, meta: meta36), CGRect(x: 0, y: 0, width: 512, height: 512))
        XCTAssertEqual(SpriteSheet.cell(5, meta: meta36), CGRect(x: 2560, y: 0, width: 512, height: 512))
        XCTAssertEqual(SpriteSheet.cell(7, meta: meta36), CGRect(x: 512, y: 512, width: 512, height: 512))
        XCTAssertEqual(SpriteSheet.cell(35, meta: meta36), CGRect(x: 2560, y: 2560, width: 512, height: 512))
        XCTAssertNil(SpriteSheet.cell(36, meta: meta36))
        XCTAssertNil(SpriteSheet.cell(-1, meta: meta36))
    }

    func testCellsScaleToADownsampledSheet() {
        // Decoded at half size for a small tile.
        XCTAssertEqual(SpriteSheet.cell(7, meta: meta36, pixelWidth: 1536, pixelHeight: 1536), CGRect(x: 256, y: 256, width: 256, height: 256))
        // An odd size rounds to whole pixels and never leaves the sheet.
        let odd = SpriteSheet.cell(35, meta: meta36, pixelWidth: 1000, pixelHeight: 1000)
        XCTAssertEqual(odd?.maxX, 1000)
        XCTAssertEqual(odd?.maxY, 1000)
        XCTAssertEqual(SpriteSheet.cells(meta: meta36, pixelWidth: 1536, pixelHeight: 1536).count, 36)
    }

    func testPartialLastRowAndTallFrames() {
        // packSprites packs tall frames into more columns; 10 frames in 4 × 3 leaves two cells empty.
        let meta = SpriteMeta(frames: 10, cols: 4, rows: 3, frameW: 300, frameH: 200, sheetW: 1200, sheetH: 600, fps: 12)
        XCTAssertEqual(SpriteSheet.cell(9, meta: meta), CGRect(x: 300, y: 400, width: 300, height: 200))
        XCTAssertNil(SpriteSheet.cell(10, meta: meta))
        XCTAssertEqual(SpriteSheet.cells(meta: meta, pixelWidth: 1200, pixelHeight: 600).count, 10)
    }

    func testInvalidLayoutsGiveNoCells() {
        var meta = meta36
        meta.frames = 37 // more frames than cells
        XCTAssertFalse(meta.isValid)
        XCTAssertNil(SpriteSheet.cell(0, meta: meta))
        meta = meta36
        meta.sheetW = 3000 // cells run off the sheet
        XCTAssertFalse(meta.isValid)
    }

    func testFrameIndexLoopsAtFps() {
        XCTAssertEqual(SpriteSheet.frameIndex(at: 0, frames: 36, fps: 24), 0)
        XCTAssertEqual(SpriteSheet.frameIndex(at: 1, frames: 36, fps: 24), 24)
        XCTAssertEqual(SpriteSheet.frameIndex(at: 1.5, frames: 36, fps: 24), 0)
        XCTAssertEqual(SpriteSheet.frameIndex(at: -1 / 24, frames: 36, fps: 24), 35)
        XCTAssertEqual(SpriteSheet.frameIndex(at: .nan, frames: 36, fps: 24), 0)
    }

    /// End to end on a real PNG: 4 cells, each with an opaque square that moves; the frames come back trimmed
    /// to the union of the squares, so the loop never jitters. A blank sheet gives nil (the still stands in).
    func testSliceTrimsEveryFrameToTheUnionOfOpaquePixels() throws {
        let meta = SpriteMeta(frames: 4, cols: 2, rows: 2, frameW: 100, frameH: 100, sheetW: 200, sheetH: 200, fps: 8)
        let squares = [CGRect(x: 20, y: 30, width: 40, height: 40), CGRect(x: 30, y: 30, width: 40, height: 40),
                       CGRect(x: 20, y: 40, width: 40, height: 40), CGRect(x: 30, y: 40, width: 40, height: 40)]
        let file = try writeSheet(meta: meta, squares: squares)
        let frames = try XCTUnwrap(SpinLoopLoader.slice(file: file, meta: meta, framePixels: 100))
        XCTAssertEqual(frames.frames.count, 4)
        XCTAssertEqual(frames.fps, 8)
        // Union: x 20...70, y 30...80 (50 × 50), plus the scan's small margin.
        let first = try XCTUnwrap(frames.frames.first)
        XCTAssertEqual(Double(first.width), 50, accuracy: 6)
        XCTAssertEqual(Double(first.height), 50, accuracy: 6)
        XCTAssertTrue(frames.frames.allSatisfy { $0.width == first.width && $0.height == first.height })

        let blank = try writeSheet(meta: meta, squares: [])
        XCTAssertNil(SpinLoopLoader.slice(file: blank, meta: meta, framePixels: 100))
    }

    private func writeSheet(meta: SpriteMeta, squares: [CGRect]) throws -> URL {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: meta.sheetW, height: meta.sheetH, bitsPerComponent: 8, bytesPerRow: meta.sheetW * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        // Top-left origin, as the sheet is laid out.
        context.translateBy(x: 0, y: CGFloat(meta.sheetH))
        context.scaleBy(x: 1, y: -1)
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        for (index, square) in squares.enumerated() {
            let cell = try XCTUnwrap(SpriteSheet.cell(index, meta: meta))
            context.fill(square.offsetBy(dx: cell.minX, dy: cell.minY))
        }
        let image = try XCTUnwrap(context.makeImage())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sheet-\(UUID().uuidString).png")
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: Library fields

    func testLibraryDecodesDesignRackAndBundleAndLITHasNone() throws {
        let value = try JSONValue.parse("""
        {
          "serverNow": 1758000000000,
          "releases": [
            { "releaseId": "r1", "slug": "lit", "title": "LIT", "ownership": "owned", "editionNumber": 7,
              "unwrapped": true, "dropAt": null, "theme": null, "lend": null,
              "bundle": { "url": "https://cdn.example.com/lit-1.0.0.zip", "sha256": "aa", "version": "1.0.0" } },
            { "releaseId": "r2", "slug": "blood", "title": "BLOOD", "ownership": "owned", "editionNumber": 19,
              "unwrapped": true, "dropAt": null, "theme": null, "lend": null,
              "design": { "v": 1, "slug": "blood", "title": "BLOOD", "artist": "Tha Myind", "year": 2026,
                "coverArt": "https://cdn.example.com/blood/cover.png", "shell": "red",
                "tracks": [{ "n": 1, "title": "Blood", "durationSec": 201 }, { "n": 2, "title": "Vein", "durationSec": 184 }],
                "theme": { "accent": "#E63024", "backdrop": { "blurPx": 10, "scrim": 0.7 } } },
              "rack": { "spriteUrl": "https://cdn.example.com/blood/spin.webp", "spriteFormat": "webp",
                "spriteMeta": { "frames": 36, "cols": 6, "rows": 6, "frameW": 512, "frameH": 512,
                                "sheetW": 3072, "sheetH": 3072, "fps": 24, "format": "image/webp" },
                "pngSpriteUrl": "https://cdn.example.com/blood/spin.png",
                "stillUrl": "https://cdn.example.com/blood/still.png" },
              "bundle": { "url": "https://cdn.example.com/blood-1.0.0.zip", "sha256": "bb", "version": "1.0.0" } }
          ]
        }
        """)
        let library = APIDecoding.library(value)
        let lit = try XCTUnwrap(library.releases.first { $0.slug == "lit" })
        XCTAssertNil(lit.design)
        XCTAssertNil(lit.rack)
        XCTAssertEqual(lit.bundle?.version, "1.0.0")

        let blood = try XCTUnwrap(library.releases.first { $0.slug == "blood" })
        XCTAssertEqual(blood.design?.shell, "red")
        XCTAssertEqual(blood.design?.tracks.map(\.title), ["Blood", "Vein"])
        XCTAssertEqual(blood.design?.theme?.backdrop?.blurPx, 10)
        XCTAssertEqual(blood.artist, "Tha Myind") // filled from the design
        XCTAssertEqual(blood.year, "2026")
        XCTAssertEqual(blood.rack?.spriteFormat, "webp")
        XCTAssertEqual(blood.rack?.meta, meta36)
        XCTAssertEqual(blood.rack?.stillURL?.absoluteString, "https://cdn.example.com/blood/still.png")
        XCTAssertEqual(blood.rack?.pngURL?.absoluteString, "https://cdn.example.com/blood/spin.png")
        XCTAssertEqual(blood.bundle?.url?.absoluteString, "https://cdn.example.com/blood-1.0.0.zip")
        XCTAssertEqual(blood.bundle?.sha256, "bb")
    }

    func testRackIsNilWithoutAUsableSheet() throws {
        XCTAssertNil(APIDecoding.rack(try JSONValue.parse(#"{ "spriteUrl": "https://x/s.png" }"#)))
        XCTAssertNil(APIDecoding.rack(try JSONValue.parse(#"{ "spriteMeta": { "frames": 4, "cols": 2, "frameW": 8, "frameH": 8 } }"#)))
        // Missing format, rows and sheet size are derived; fps defaults to 24.
        let rack = try XCTUnwrap(APIDecoding.rack(try JSONValue.parse(
            #"{ "spriteUrl": "https://x/s.png", "spriteMeta": { "frames": 5, "cols": 2, "frameW": 8, "frameH": 8 } }"#
        )))
        XCTAssertEqual(rack.spriteFormat, "png")
        XCTAssertEqual(rack.meta.rows, 3)
        XCTAssertEqual(rack.meta.sheetH, 24)
        XCTAssertEqual(rack.meta.fps, 24)
        XCTAssertNil(rack.stillURL)
    }

    func testContextDecodesDesignAndRack() throws {
        let value = try JSONValue.parse(#"{ "slug": "blood", "ownership": "owned", "design": { "coverArt": "blood/cover.png" } }"#)
        let context = APIDecoding.context(value, slug: "blood")
        XCTAssertEqual(context.design?.coverArt, "blood/cover.png")
        XCTAssertNil(context.rack)
    }

    // MARK: Backdrop

    func testBackdropFallsBackToTheCityWithoutADesign() {
        // LIT: no design, so the city even when a cover URL exists.
        XCTAssertEqual(BackdropRules.choice(coverURL: URL(string: "https://x/lit.png"), design: nil, bundledArt: nil), .city)
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: nil, bundledArt: nil), .city)
    }

    func testBackdropFallsBackToTheCityWhenNoArtResolves() {
        // Relative art with no base (an API design) and no installed bundle to read it from.
        let design = DiscDesign(coverArt: "blood/cover.png")
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: nil), .city)
    }

    func testBackdropUsesTheCoverWithDefaults() {
        var design = DiscDesign(coverArt: "blood/cover.png")
        design.baseURL = URL(fileURLWithPath: "/samples/blood.json")
        XCTAssertEqual(
            BackdropRules.choice(coverURL: nil, design: design, bundledArt: nil),
            .art(URL(fileURLWithPath: "/samples/blood/cover.png"), blurPx: 12, scrim: 0.62)
        )
    }

    func testBackdropPrefersTheBackdropImageThenTheCoverThenTheBundle() {
        let bundled = URL(fileURLWithPath: "/bundles/blood/1.0.0/design/cover.png")
        var design = DiscDesign(coverArt: "cover.png")
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: bundled).artURL, bundled)
        design.coverArt = "https://cdn.example.com/cover.png"
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: bundled).artURL?.absoluteString,
                       "https://cdn.example.com/cover.png")
        design.theme = DiscDesign.Theme(backdrop: .init(image: "https://cdn.example.com/backdrop.png"))
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: bundled).artURL?.absoluteString,
                       "https://cdn.example.com/backdrop.png")
        XCTAssertEqual(BackdropRules.choice(coverURL: URL(string: "https://cdn.example.com/library-cover.png"), design: design, bundledArt: bundled)
            .artURL?.absoluteString, "https://cdn.example.com/library-cover.png")
    }

    func testBackdropReadsBlurAndScrimFromTheThemeAndKeepsTextLegible() {
        var design = DiscDesign(coverArt: "https://cdn.example.com/cover.png")
        design.theme = DiscDesign.Theme(backdrop: .init(blurPx: 20, scrim: 0.75))
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: nil),
                       .art(URL(string: "https://cdn.example.com/cover.png")!, blurPx: 20, scrim: 0.75))
        // A too-light scrim is raised to the legibility floor; a huge blur is capped.
        design.theme = DiscDesign.Theme(backdrop: .init(blurPx: 400, scrim: 0.1))
        XCTAssertEqual(BackdropRules.choice(coverURL: nil, design: design, bundledArt: nil),
                       .art(URL(string: "https://cdn.example.com/cover.png")!, blurPx: BackdropRules.maxBlurPx, scrim: BackdropRules.minScrim))
    }

    // MARK: Tile layout

    func testRenderFaceIsTheSquareAtTheFoot() {
        let face = RackRules.renderFace(width: 100, height: 160)
        XCTAssertEqual(face.width, 92, accuracy: 0.001)
        XCTAssertEqual(face.height, 92, accuracy: 0.001)
        XCTAssertEqual(face.maxY, 160, accuracy: 0.001)
        XCTAssertEqual(face.midX, 50, accuracy: 0.001)
        XCTAssertEqual(RackRules.loopPhase(slug: "blood"), RackRules.loopPhase(slug: "blood"))
    }
}
