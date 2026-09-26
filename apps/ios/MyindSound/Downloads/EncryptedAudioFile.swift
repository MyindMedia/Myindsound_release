import CryptoKit
import Foundation

/// AUD-3/AUD-4: the on-disk format of a downloaded track. Plain audio never touches disk: the downloader
/// feeds network bytes straight into `Writer`, which seals each chunk with AES-GCM (CryptoKit) before it is
/// written, and `Reader` decrypts only the byte range the player asks for, in memory.
///
/// Format, version 1 (all integers big endian):
///
///     header (40 bytes)
///       0  magic        "MSE1"                    4 bytes
///       4  version      1                         u8
///       5  reserved     0                         3 bytes
///       8  chunkSize    plaintext bytes per chunk u32   (default 256 KiB)
///      12  fileId       random                    16 bytes
///      28  length       total plaintext bytes     u64   (written when the download finishes)
///      36  reserved     0                         u32
///     chunk i (i = 0 ..< n), n = max(1, ceil(length / chunkSize))
///       nonce       12 bytes, random per chunk
///       ciphertext  chunkSize bytes (the last chunk: the remainder, 0 ... chunkSize)
///       tag         16 bytes
///
/// Every chunk authenticates `magic | version | chunkSize | fileId | i (u64) | final (u8)` as associated data,
/// so a chunk can't be moved to another position or another file, and a file cut short at a chunk boundary
/// fails (its new last chunk was sealed with final = 0). `length` itself isn't sealed, but it has to agree
/// with the file size and with which chunk opens as final, so changing it fails too. The key is the fan's
/// per-user download key from the Keychain (`DownloadKeychain`).
enum EncryptedAudioFile {
    static let magic = Data("MSE1".utf8)
    static let formatVersion: UInt8 = 1
    static let headerSize = 40
    static let nonceSize = 12
    static let tagSize = 16
    static let overhead = nonceSize + tagSize
    static let defaultChunkSize = 256 * 1024

    enum FormatError: Error, Equatable {
        case badHeader
        case badSize
        case authenticationFailed(chunk: Int)
        case outOfRange
        case finished
    }

    struct Header: Equatable {
        var chunkSize: Int
        var fileId: Data
        var length: UInt64

        func encoded() -> Data {
            var out = Data()
            out.append(magic)
            out.append(formatVersion)
            out.append(contentsOf: [0, 0, 0])
            out.appendBE(UInt32(chunkSize))
            out.append(fileId)
            out.appendBE(length)
            out.appendBE(UInt32(0))
            return out
        }

        static func decode(_ data: Data) throws -> Header {
            guard data.count >= headerSize, data.prefix(4) == magic, data[data.startIndex + 4] == formatVersion else {
                throw FormatError.badHeader
            }
            let chunkSize = Int(data.readBE32(8))
            guard chunkSize > 0, chunkSize <= 16 * 1024 * 1024 else { throw FormatError.badHeader }
            let fileId = data.subdata(in: (data.startIndex + 12)..<(data.startIndex + 28))
            return Header(chunkSize: chunkSize, fileId: fileId, length: data.readBE64(28))
        }

        var chunkCount: Int {
            max(1, Int((length + UInt64(chunkSize) - 1) / UInt64(chunkSize)))
        }

        /// The file size this header implies.
        var fileSize: UInt64 {
            UInt64(headerSize) + UInt64(chunkCount * overhead) + length
        }

        func associatedData(chunk index: Int, final: Bool) -> Data {
            var out = Data()
            out.append(magic)
            out.append(formatVersion)
            out.appendBE(UInt32(chunkSize))
            out.append(fileId)
            out.appendBE(UInt64(index))
            out.append(final ? 1 : 0)
            return out
        }
    }

    // MARK: Writing (streaming)

    /// Seals plaintext as it arrives. Holds at most one chunk of plaintext in memory, never on disk.
    final class Writer {
        private let handle: FileHandle
        private let key: SymmetricKey
        private var header: Header
        private var pending = Data()
        private var index = 0
        private var total: UInt64 = 0
        private var done = false

        init(fileURL: URL, key: SymmetricKey, chunkSize: Int = EncryptedAudioFile.defaultChunkSize) throws {
            let fm = FileManager.default
            try fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard fm.createFile(atPath: fileURL.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
                throw CocoaError(.fileWriteUnknown)
            }
            handle = try FileHandle(forWritingTo: fileURL)
            self.key = key
            var fileId = Data(count: 16)
            let status = fileId.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
            guard status == errSecSuccess else { throw CocoaError(.fileWriteUnknown) }
            header = Header(chunkSize: chunkSize, fileId: fileId, length: 0)
            try handle.write(contentsOf: header.encoded())
        }

        deinit { try? handle.close() }

        /// Adds bytes. A chunk is sealed only once more bytes follow it, so the last chunk is always sealed
        /// as final by `finish()`.
        func append(_ data: Data) throws {
            guard !done else { throw FormatError.finished }
            pending.append(data)
            total += UInt64(data.count)
            while pending.count > header.chunkSize {
                try seal(pending.prefix(header.chunkSize), final: false)
                pending = Data(pending.dropFirst(header.chunkSize))
            }
        }

        /// Seals the last chunk and writes the length. Returns the plaintext length.
        @discardableResult
        func finish() throws -> UInt64 {
            guard !done else { throw FormatError.finished }
            try seal(pending, final: true)
            pending = Data()
            done = true
            header.length = total
            try handle.seek(toOffset: 0)
            try handle.write(contentsOf: header.encoded())
            try handle.synchronize()
            try handle.close()
            return total
        }

        private func seal(_ plaintext: Data, final: Bool) throws {
            let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(), authenticating: header.associatedData(chunk: index, final: final))
            var out = Data(box.nonce)
            out.append(box.ciphertext)
            out.append(box.tag)
            try handle.write(contentsOf: out)
            index += 1
        }
    }

    /// Seals a whole buffer (tests, small files).
    static func write(_ plaintext: Data, to url: URL, key: SymmetricKey, chunkSize: Int = defaultChunkSize) throws {
        let writer = try Writer(fileURL: url, key: key, chunkSize: chunkSize)
        var offset = 0
        // Uneven slices, as a network delivers them.
        while offset < plaintext.count {
            let size = min(plaintext.count - offset, 7_919)
            try writer.append(plaintext.subdata(in: offset..<(offset + size)))
            offset += size
        }
        try writer.finish()
    }

    // MARK: Reading (ranges, in memory)

    /// Decrypts byte ranges on demand. Keeps the last chunk it opened, so sequential reads open each chunk once.
    final class Reader {
        let header: Header
        private let handle: FileHandle
        private let key: SymmetricKey
        private var cached: (index: Int, plaintext: Data)?
        private let lock = NSLock()

        var length: UInt64 { header.length }

        init(fileURL: URL, key: SymmetricKey) throws {
            handle = try FileHandle(forReadingFrom: fileURL)
            self.key = key
            guard let head = try handle.read(upToCount: headerSize) else { throw FormatError.badHeader }
            header = try Header.decode(head)
            let size = try handle.seekToEnd()
            guard size == header.fileSize else { throw FormatError.badSize }
        }

        deinit { try? handle.close() }

        /// Plaintext bytes `offset ..< offset + count` (clamped to the end).
        func read(offset: UInt64, count: Int) throws -> Data {
            lock.lock()
            defer { lock.unlock() }
            guard offset <= header.length else { throw FormatError.outOfRange }
            let end = min(header.length, offset + UInt64(max(0, count)))
            guard end > offset else { return Data() }
            let size = UInt64(header.chunkSize)
            var out = Data(capacity: Int(end - offset))
            var position = offset
            while position < end {
                let index = Int(position / size)
                let chunk = try plaintext(chunk: index)
                let start = Int(position - UInt64(index) * size)
                let take = min(chunk.count - start, Int(end - position))
                guard take > 0 else { throw FormatError.outOfRange }
                out.append(chunk.subdata(in: start..<(start + take)))
                position += UInt64(take)
            }
            return out
        }

        private func plaintext(chunk index: Int) throws -> Data {
            if let cached, cached.index == index { return cached.plaintext }
            let count = header.chunkCount
            guard index < count else { throw FormatError.outOfRange }
            let final = index == count - 1
            let plainSize = final ? Int(header.length - UInt64(index) * UInt64(header.chunkSize)) : header.chunkSize
            let offset = UInt64(headerSize) + UInt64(index) * UInt64(header.chunkSize + overhead)
            try handle.seek(toOffset: offset)
            guard let raw = try handle.read(upToCount: plainSize + overhead), raw.count == plainSize + overhead else {
                throw FormatError.badSize
            }
            do {
                let box = try AES.GCM.SealedBox(
                    nonce: AES.GCM.Nonce(data: raw.prefix(nonceSize)),
                    ciphertext: raw.subdata(in: (raw.startIndex + nonceSize)..<(raw.endIndex - tagSize)),
                    tag: raw.suffix(tagSize)
                )
                let plain = try AES.GCM.open(box, using: key, authenticating: header.associatedData(chunk: index, final: final))
                cached = (index, plain)
                return plain
            } catch {
                throw FormatError.authenticationFailed(chunk: index)
            }
        }
    }
}

private extension Data {
    mutating func appendBE(_ value: UInt32) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }

    mutating func appendBE(_ value: UInt64) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }

    func readBE32(_ offset: Int) -> UInt32 {
        (0..<4).reduce(UInt32(0)) { $0 << 8 | UInt32(self[startIndex + offset + $1]) }
    }

    func readBE64(_ offset: Int) -> UInt64 {
        (0..<8).reduce(UInt64(0)) { $0 << 8 | UInt64(self[startIndex + offset + $1]) }
    }
}
