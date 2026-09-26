import Foundation

/// Debug only: the sample generated discs from `packages/minidisc`, embedded as `DevDiscs/` by a Debug-only build
/// phase (project.yml "Embed dev disc renders"), so `-mock` runs show real renders with no hosting:
/// `DevDiscs/shots/<name>-spin.{webp,png,json}` + `<name>-still.png` (the publish-time spin loops) and
/// `DevDiscs/samples/<name>.json` + its art (the DiscDesigns). The build copies them fresh every time, so the
/// newest renders are always used. Release builds carry none of it and every lookup is nil.
enum DevDiscs {
    static var root: URL? {
        #if DEBUG
        let url = Bundle.main.resourceURL?.appendingPathComponent("DevDiscs", isDirectory: true)
        return url.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
        #else
        return nil
        #endif
    }

    /// `samples/<name>.json` as the API would send it, with its relative art resolving next to the file.
    static func design(_ name: String) -> DiscDesign? {
        guard let dir = root?.appendingPathComponent("samples", isDirectory: true),
              let data = try? Data(contentsOf: dir.appendingPathComponent("\(name).json")),
              let value = try? JSONValue.parse(data),
              var design = APIDecoding.design(value) else { return nil }
        design.baseURL = dir.appendingPathComponent("\(name).json")
        return design
    }

    /// `shots/<name>-spin.*`: WebP when present (what the portal publishes by default), else PNG.
    static func rack(_ name: String) -> RackRender? {
        guard let dir = root?.appendingPathComponent("shots", isDirectory: true),
              let data = try? Data(contentsOf: dir.appendingPathComponent("\(name)-spin.json")),
              let meta = APIDecoding.spriteMeta(try? JSONValue.parse(data)) else { return nil }
        let fm = FileManager.default
        let webp = dir.appendingPathComponent("\(name)-spin.webp"), png = dir.appendingPathComponent("\(name)-spin.png")
        let sheet = fm.fileExists(atPath: webp.path) ? webp : png
        guard fm.fileExists(atPath: sheet.path) else { return nil }
        let still = dir.appendingPathComponent("\(name)-still.png")
        return RackRender(
            spriteURL: sheet,
            spriteFormat: sheet.pathExtension,
            meta: meta,
            stillURL: fm.fileExists(atPath: still.path) ? still : nil,
            pngURL: sheet != png && fm.fileExists(atPath: png.path) ? png : nil
        )
    }

    /// The first of `names` that has a render (a missing sample borrows another's loop).
    static func rack(anyOf names: [String]) -> RackRender? {
        names.lazy.compactMap { rack($0) }.first
    }
}
