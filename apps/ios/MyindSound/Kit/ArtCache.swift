import CoreImage
import CryptoKit
import Foundation
import ImageIO
import UIKit

/// Remote release art on disk (spin-loop sheets, stills, covers): Application Support/art/<sha256(url)>.<ext>,
/// excluded from backup, so the rack and the backdrops work offline once seen. File URLs (the Debug build's
/// embedded samples, an installed bundle's `design/` folder) are read in place.
actor ArtCache {
    static let shared = ArtCache()

    let directory: URL
    private var inFlight: [URL: Task<URL, Error>] = [:]

    init(directory: URL = ArtCache.defaultDirectory) {
        self.directory = directory
    }

    static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("art", isDirectory: true)
    }

    /// The cache file for `url` (the key is the URL, so a re-render published under a new URL is a new file).
    nonisolated func fileURL(for url: URL) -> URL {
        let hash = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension.lowercased()
        return directory.appendingPathComponent("\(hash).\(ext)")
    }

    /// A local file holding `url`'s bytes: the file itself, the cached copy, or a fresh https download.
    func localFile(for url: URL) async throws -> URL {
        if url.isFileURL { return url }
        let target = fileURL(for: url)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        if let task = inFlight[url] { return try await task.value }
        let directory = directory
        let task = Task<URL, Error> {
            guard url.scheme?.lowercased() == "https" else { throw URLError(.unsupportedURL) }
            let (file, response) = try await URLSession.shared.download(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                try? FileManager.default.removeItem(at: file)
                throw URLError(.badServerResponse)
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            BundleStore.excludeFromBackup(directory)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: file, to: target)
            return target
        }
        inFlight[url] = task
        defer { inFlight[url] = nil }
        return try await task.value
    }
}

/// Decoding helpers shared by the spin loops and the backdrops (ImageIO: WebP and PNG decode natively).
enum ArtDecode {
    /// The image at `file`, downsampled so its longer side is at most `maxPixel` (nil: full size), decoded now.
    static func image(at file: URL, maxPixel: Int?) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let size = pixelSize(source)
        if let maxPixel, max(size.width, size.height) > maxPixel {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    static func pixelSize(_ source: CGImageSource) -> (width: Int, height: Int) {
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        return ((props?[kCGImagePropertyPixelWidth] as? Int) ?? 0, (props?[kCGImagePropertyPixelHeight] as? Int) ?? 0)
    }

    /// An 8-bit premultiplied RGBA bitmap of `image`, so its alpha can be read and cells copied out of it.
    static func bitmap(_ image: CGImage) -> CGContext? {
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context
    }

    private static let ciContext = CIContext(options: [.cacheIntermediates: false])

    /// A Gaussian blur of `sigma` pixels with clamped edges (no dark fringe), same size as the input.
    static func blurred(_ image: CGImage, sigma: Double) -> CGImage? {
        guard sigma > 0.5 else { return image }
        let input = CIImage(cgImage: image)
        guard let filter = CIFilter(name: "CIGaussianBlur") else { return image }
        filter.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        filter.setValue(sigma, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent) else { return image }
        return ciContext.createCGImage(output, from: input.extent)
    }
}
