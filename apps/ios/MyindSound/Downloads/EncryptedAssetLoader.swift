import AVFoundation
import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// AUD-4: plays a downloaded track through `AVURLAsset` on the `myind-enc://` scheme. AVFoundation can't
/// fetch that scheme, so it asks this delegate for byte ranges, which are decrypted in memory from the
/// chunked ciphertext (`EncryptedAudioFile.Reader`) and handed straight to the player. Plain audio never
/// touches disk. One loader per asset; the asset's resource loader holds it weakly, so `DownloadManager`
/// keeps it alive.
final class EncryptedAssetLoader: NSObject, AVAssetResourceLoaderDelegate {
    static let scheme = "myind-enc"
    /// Largest slice handed to the player per `respond(with:)`.
    static let responseSlice = 256 * 1024

    let reader: EncryptedAudioFile.Reader
    let contentType: String
    let queue = DispatchQueue(label: "com.myindsound.encrypted-asset", qos: .userInitiated)

    init(fileURL: URL, key: SymmetricKey, mimeType: String) throws {
        reader = try EncryptedAudioFile.Reader(fileURL: fileURL, key: key)
        contentType = UTType(mimeType: mimeType)?.identifier ?? UTType.mp3.identifier
    }

    /// An asset for `trackId` whose bytes come from this loader.
    func makeAsset(trackId: String) -> AVURLAsset {
        let url = URL(string: "\(Self.scheme)://track/\(trackId)")!
        let asset = AVURLAsset(url: url)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard loadingRequest.request.url?.scheme == Self.scheme else { return false }
        if let info = loadingRequest.contentInformationRequest {
            info.contentType = contentType
            info.contentLength = Int64(reader.length)
            info.isByteRangeAccessSupported = true
        }
        guard loadingRequest.dataRequest != nil else {
            loadingRequest.finishLoading()
            return true
        }
        // Answer on the next turn of the queue, so a cancel for a long request can land between slices.
        queue.async { [reader] in Self.serve(loadingRequest, from: reader) }
        return true
    }

    static func serve(_ loadingRequest: AVAssetResourceLoadingRequest, from reader: EncryptedAudioFile.Reader) {
        guard let data = loadingRequest.dataRequest, !loadingRequest.isCancelled else { return }
        let start = UInt64(max(0, data.currentOffset != 0 ? data.currentOffset : data.requestedOffset))
        let end: UInt64 = data.requestsAllDataToEndOfResource
            ? reader.length
            : min(reader.length, UInt64(data.requestedOffset) + UInt64(data.requestedLength))
        var position = start
        do {
            while position < end {
                if loadingRequest.isCancelled { return }
                let count = Int(min(UInt64(responseSlice), end - position))
                let bytes = try reader.read(offset: position, count: count)
                guard !bytes.isEmpty else { break }
                data.respond(with: bytes)
                position += UInt64(bytes.count)
            }
            loadingRequest.finishLoading()
        } catch {
            loadingRequest.finishLoading(with: error)
        }
    }
}
