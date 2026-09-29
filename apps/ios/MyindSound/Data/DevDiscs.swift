import Foundation

/// Debug only: the sample generated discs from `packages/minidisc`, embedded as `DevDiscs/` by a Debug-only build
/// phase (project.yml "Embed dev disc renders"), so `-mock` runs show real renders with no hosting:
/// `DevDiscs/shots/<name>-sleeve.{webp,png}` (the publish-time rack stills, `renderSleeveStill`) and
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

    /// `shots/<name>-sleeve.png` (+ `.webp`, tried first), as the API's `rack.stillUrl` / `stillWebpUrl`.
    static func rack(_ name: String) -> RackRender? {
        guard let dir = root?.appendingPathComponent("shots", isDirectory: true) else { return nil }
        let fm = FileManager.default
        let png = dir.appendingPathComponent("\(name)-sleeve.png"), webp = dir.appendingPathComponent("\(name)-sleeve.webp")
        guard fm.fileExists(atPath: png.path) else { return nil }
        let cart = [dir.appendingPathComponent("\(name)-cart.webp"), dir.appendingPathComponent("\(name)-cart.png")].first { fm.fileExists(atPath: $0.path) }
        return RackRender(stillURL: png, stillWebpURL: fm.fileExists(atPath: webp.path) ? webp : nil, cartURL: cart)
    }

    /// The first of `names` that has a render (a missing sample borrows another's).
    static func rack(anyOf names: [String]) -> RackRender? {
        names.lazy.compactMap { rack($0) }.first
    }
}
