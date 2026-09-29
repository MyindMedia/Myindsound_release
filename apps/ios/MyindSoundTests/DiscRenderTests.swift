import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import MyindSound

/// Generated discs: the rack's still (one render of the sleeve, the disc inside; how it decodes and where its face
/// is), the library's `design` / `rack` / `bundle` fields (LIT has none from the API), and which backdrop a release
/// gets. Values are made up.
final class DiscRenderTests: XCTestCase {
    // MARK: Rack still

    func testStillFaceIsInsideTheImageAndNearlySquare() {
        let face = RackStill.face
        XCTAssertGreaterThan(face.minX, 0)
        XCTAssertGreaterThan(face.minY, 0)
        XCTAssertLessThan(face.maxX, 1)
        XCTAssertLessThan(face.maxY, 1)
        // The printed front is square and seen square on (the live sleeve's opening frame), so its bounds are too.
        XCTAssertEqual(face.width / face.height, 1, accuracy: 0.05)
        XCTAssertEqual(RackStill.face(side: 200), CGRect(x: face.minX * 200, y: face.minY * 200, width: face.width * 200, height: face.height * 200))
    }

    func testStillCandidatesTryWebPFirst() {
        let png = URL(string: "https://cdn.example.com/blood/still.png")!, webp = URL(string: "https://cdn.example.com/blood/still.webp")!
        XCTAssertEqual(RackRender(stillURL: png, stillWebpURL: webp).candidates, [webp, png])
        XCTAssertEqual(RackRender(stillURL: png).candidates, [png])
    }

    /// End to end on a real PNG with alpha: it decodes, downsampled to the tile size; a non-image gives nil.
    func testStillDecodesDownsampledAndRejectsNonImages() throws {
        let file = try writePNG(size: 1200)
        let image = try XCTUnwrap(RackStillLoader.decode(file: file, maxPixels: 300))
        XCTAssertEqual(max(image.width, image.height), 300)
        let junk = FileManager.default.temporaryDirectory.appendingPathComponent("junk-\(UUID().uuidString).png")
        try Data("not an image".utf8).write(to: junk)
        addTeardownBlock { try? FileManager.default.removeItem(at: junk) }
        XCTAssertNil(RackStillLoader.decode(file: junk))
    }

    func testLITHasABuiltInStill() throws {
        let lit = try XCTUnwrap(RackRender.builtIn(slug: "lit", bundle: Bundle(for: AppModel.self)))
        XCTAssertEqual(lit.stillURL.lastPathComponent, "lit-sleeve.webp")
        XCTAssertTrue(FileManager.default.fileExists(atPath: lit.stillURL.path))
        XCTAssertNotNil(RackStillLoader.decode(file: lit.stillURL))
        XCTAssertNil(RackRender.builtIn(slug: "blood", bundle: Bundle(for: AppModel.self)))
    }

    private func writePNG(size: Int) throws -> URL {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: size / 8, y: size / 8, width: size * 3 / 4, height: size * 3 / 4))
        let image = try XCTUnwrap(context.makeImage())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-\(UUID().uuidString).png")
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
              "rack": { "stillUrl": "https://cdn.example.com/blood/still.png",
                "stillWebpUrl": "https://cdn.example.com/blood/still.webp",
                "spriteUrl": null, "spriteFormat": null, "spriteMeta": null, "pngSpriteUrl": null },
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
        XCTAssertEqual(blood.rack?.stillURL.absoluteString, "https://cdn.example.com/blood/still.png")
        XCTAssertEqual(blood.rack?.stillWebpURL?.absoluteString, "https://cdn.example.com/blood/still.webp")
        XCTAssertEqual(blood.bundle?.url?.absoluteString, "https://cdn.example.com/blood-1.0.0.zip")
        XCTAssertEqual(blood.bundle?.sha256, "bb")
    }

    func testRackNeedsAStillAndIgnoresTheSpinLoop() throws {
        // A spin loop alone (an older render) is not a rack image: the printed sleeve stands in.
        XCTAssertNil(APIDecoding.rack(try JSONValue.parse(
            #"{ "spriteUrl": "https://x/s.png", "spriteMeta": { "frames": 4, "cols": 2, "frameW": 8, "frameH": 8 } }"#
        )))
        XCTAssertNil(APIDecoding.rack(try JSONValue.parse(#"{ "stillUrl": "not a url" }"#)))
        XCTAssertNil(APIDecoding.rack(nil))
        let rack = try XCTUnwrap(APIDecoding.rack(try JSONValue.parse(
            #"{ "stillUrl": "https://x/still.png", "stillWebpUrl": null, "spriteUrl": "https://x/s.png" }"#
        )))
        XCTAssertEqual(rack.stillURL.absoluteString, "https://x/still.png")
        XCTAssertNil(rack.stillWebpURL)
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

    // MARK: Focus layout

    func testFocusPutsTheStillsFaceWhereThePrintedSleeveGoes() {
        let layout = FocusLayout(size: CGSize(width: 390, height: 844))
        let printed = layout.sleeveFrame(rendered: false)
        let rendered = layout.sleeveFrame(rendered: true)
        XCTAssertEqual(printed.width, layout.sleeveWidth, accuracy: 0.001)
        // The still is bigger (margin, spine, shadow), and its face lands on the printed sleeve's square.
        let face = CGRect(x: rendered.minX + RackStill.face.minX * rendered.width, y: rendered.minY + RackStill.face.minY * rendered.height,
                          width: RackStill.face.width * rendered.width, height: RackStill.face.height * rendered.height)
        XCTAssertEqual(face.width, printed.width, accuracy: 0.001)
        XCTAssertEqual(face.midX, printed.midX, accuracy: 0.001)
        XCTAssertEqual(face.midY, printed.midY, accuracy: 0.001)
        XCTAssertEqual(rendered.width, rendered.height, accuracy: 0.001)
    }
}
