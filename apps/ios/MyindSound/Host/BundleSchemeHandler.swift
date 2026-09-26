import Foundation
import WebKit

/// BUN-3: serves one unpacked release bundle to its WKWebView on `myind-bundle://<slug>/...`, from disk, never
/// the network. Only files inside the bundle root are served (no `..`, no symlinks out, no directories), with
/// the right MIME type and byte ranges. The entry HTML gets the per-page bridge meta tag as the first element
/// of `<head>` (CONTRACT.md §2), and every response carries a CSP that keeps the page on its own scheme (BUN-5:
/// bundles never fetch audio or call Convex).
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    let slug: String
    let root: URL
    let entry: String
    /// The current page's connect token, written into the entry HTML. Set by the host before each load.
    var connectToken: String = ""

    private let queue = DispatchQueue(label: "com.myindsound.bundle-scheme", qos: .userInitiated)
    private var stopped = Set<ObjectIdentifier>()

    init(slug: String, root: URL, entry: String) {
        self.slug = slug
        self.root = root
        self.entry = entry
    }

    static let contentSecurityPolicy = [
        "default-src 'none'",
        "script-src myind-bundle:",
        "style-src myind-bundle: 'unsafe-inline'",
        "img-src myind-bundle: data: blob:",
        "font-src myind-bundle: data:",
        "media-src myind-bundle: blob: data:",
        "connect-src myind-bundle: blob: data:",
        "worker-src myind-bundle: blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'",
    ].joined(separator: "; ")

    // MARK: WKURLSchemeHandler (main thread)

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        stopped.remove(id)
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let token = connectToken
        let range = task.request.value(forHTTPHeaderField: "Range")
        queue.async { [weak self] in
            guard let self else { return }
            let response = self.respond(to: url, range: range, token: token)
            DispatchQueue.main.async {
                guard !self.stopped.contains(id) else { return }
                task.didReceive(response.head)
                if !response.body.isEmpty { task.didReceive(response.body) }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    // MARK: Responses

    struct Response {
        var head: HTTPURLResponse
        var body: Data
        var status: Int { head.statusCode }
    }

    /// Builds the whole response for `url`. Pure apart from reading the file, so tests call it directly.
    func respond(to url: URL, range: String?, token: String) -> Response {
        guard let file = Self.resolve(url, slug: slug, root: root) else {
            return Self.plain(url, status: 404, "Not found")
        }
        let relative = String(file.path.dropFirst(root.standardizedFileURL.resolvingSymlinksInPath().path.count + 1))
        guard var data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return Self.plain(url, status: 404, "Not found")
        }
        let mime = Self.mimeType(forExtension: file.pathExtension)

        if relative == entry {
            // The entry document: the per-page meta tag, never cached, never ranged.
            guard let html = String(data: data, encoding: .utf8),
                  let injected = BridgeContract.injectMeta(into: html, token: token) else {
                return Self.plain(url, status: 500, "Bad entry document")
            }
            data = Data(injected.utf8)
            return Self.ok(url, mime: mime, body: data, extra: ["Cache-Control": "no-store"])
        }

        if let range, let bounds = Self.parseRange(range, size: data.count) {
            guard let bounds else {
                return Response(head: HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Range": "bytes */\(data.count)",
                    "Content-Length": "0",
                ])!, body: Data())
            }
            let slice = data.subdata(in: bounds.lowerBound..<(bounds.upperBound + 1))
            return Self.ok(url, status: 206, mime: mime, body: slice, extra: [
                "Content-Range": "bytes \(bounds.lowerBound)-\(bounds.upperBound)/\(data.count)",
            ])
        }
        return Self.ok(url, mime: mime, body: data)
    }

    private static func ok(_ url: URL, status: Int = 200, mime: String, body: Data, extra: [String: String] = [:]) -> Response {
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(body.count),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": contentSecurityPolicy,
            // Module scripts are fetched in CORS mode; the bundle is its own origin.
            "Access-Control-Allow-Origin": "\(BridgeContract.scheme)://\(url.host ?? "")",
        ]
        headers.merge(extra) { $1 }
        return Response(head: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, body: body)
    }

    private static func plain(_ url: URL, status: Int, _ text: String) -> Response {
        let body = Data(text.utf8)
        return Response(head: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": String(body.count),
            "X-Content-Type-Options": "nosniff",
        ])!, body: body)
    }

    // MARK: Path resolution (the traversal guard)

    /// The file `url` names inside `root`, or nil. Refuses another scheme or host, `..` and `.` segments (raw
    /// or percent encoded), backslashes, NUL, anything that resolves (through symlinks) outside the root, and
    /// directories.
    static func resolve(_ url: URL, slug: String, root: URL) -> URL? {
        guard url.scheme?.lowercased() == BridgeContract.scheme, url.host == slug, url.port == nil,
              url.user == nil, url.password == nil else { return nil }
        // The raw path, before URL's own normalisation, so `/a/../b` is refused rather than collapsed.
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let rawPath = components.percentEncodedPath
        guard let decoded = rawPath.removingPercentEncoding else { return nil }
        if decoded.contains("\0") || decoded.contains("\\") { return nil }
        let segments = decoded.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !segments.isEmpty else { return nil }
        for segment in segments where segment == ".." || segment == "." || segment.hasPrefix("~") {
            return nil
        }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        var file = base
        for segment in segments { file.appendPathComponent(segment, isDirectory: false) }
        let resolved = file.standardizedFileURL.resolvingSymlinksInPath()
        guard resolved.path.hasPrefix(base.path + "/") else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return nil
        }
        return resolved
    }

    // MARK: MIME types

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "avif": return "image/avif"
        case "ktx2": return "image/ktx2"
        case "basis": return "application/octet-stream"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "bin": return "application/octet-stream"
        case "wasm": return "application/wasm"
        case "mp3": return "audio/mpeg"
        case "m4a", "mp4a": return "audio/mp4"
        case "aac": return "audio/aac"
        case "wav": return "audio/wav"
        case "ogg", "oga": return "audio/ogg"
        case "opus": return "audio/opus"
        case "mp4": return "video/mp4"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    // MARK: Ranges

    /// `bytes=a-b`, `bytes=a-`, `bytes=-n` → inclusive bounds. Nil: not a range we handle (serve the whole
    /// file). `.some(nil)`: unsatisfiable (416).
    static func parseRange(_ header: String, size: Int) -> ClosedRange<Int>?? {
        let value = header.trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("bytes="), !value.contains(",") else { return nil }
        let spec = value.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard spec.count == 2 else { return nil }
        let first = spec[0].trimmingCharacters(in: .whitespaces), last = spec[1].trimmingCharacters(in: .whitespaces)
        guard size > 0 else { return .some(nil) }
        if first.isEmpty {
            guard let suffix = Int(last), suffix > 0 else { return .some(nil) }
            return .some(max(0, size - suffix)...(size - 1))
        }
        guard let start = Int(first), start >= 0 else { return nil }
        guard start < size else { return .some(nil) }
        if last.isEmpty { return .some(start...(size - 1)) }
        guard let end = Int(last), end >= start else { return .some(nil) }
        return .some(start...min(end, size - 1))
    }
}
