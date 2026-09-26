import Compression
import Foundation

/// A small ZIP reader for release bundles (BUN-2). Why not a dependency: iOS has no public unzip API, but the
/// Compression framework decodes raw DEFLATE (`COMPRESSION_ZLIB`), and a bundle zip only needs the central
/// directory, `stored` and `deflated` entries, and a CRC check: about 150 lines we can read in full, against
/// a third-party package for something this small. The zip is SHA-256 verified against the server before it
/// gets here; this reader still treats it as hostile: every entry name is checked (no absolute paths, `..`,
/// backslashes or NUL), symlinks and encrypted or ZIP64 entries are refused, and sizes are capped so a
/// crafted archive can't fill the disk.
enum ZipArchive {
    enum ZipError: Error, Equatable {
        case notAZip
        case unsupported(String)
        case unsafePath(String)
        case tooLarge
        case corrupt(String)
    }

    struct Entry {
        var name: String
        var method: UInt16
        var crc32: UInt32
        var compressedSize: Int
        var size: Int
        var localHeaderOffset: Int
        var isDirectory: Bool { name.hasSuffix("/") }
    }

    /// NAT-5: a bundle zip is at most 40 MB; unpacked it may be a few times that.
    static let maxEntries = 5_000
    static let maxTotalSize = 400 * 1024 * 1024

    /// Unpacks `zip` into `destination` (created if needed). Throws before writing anything unsafe.
    static func extract(_ zip: URL, to destination: URL) throws {
        let data = try Data(contentsOf: zip, options: .mappedIfSafe)
        let entries = try centralDirectory(data)
        let fm = FileManager.default
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        let base = destination.standardizedFileURL.resolvingSymlinksInPath()

        var total = 0
        for entry in entries {
            total += entry.size
            guard total <= maxTotalSize else { throw ZipError.tooLarge }
            let target = try safeTarget(for: entry.name, in: base)
            if entry.isDirectory {
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            let bytes = try contents(of: entry, in: data)
            try bytes.write(to: target, options: .atomic)
        }
    }

    /// Where `name` goes under `base`, or `unsafePath`.
    static func safeTarget(for name: String, in base: URL) throws -> URL {
        guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0") else {
            throw ZipError.unsafePath(name)
        }
        let segments = name.split(separator: "/", omittingEmptySubsequences: true)
        guard !segments.isEmpty, !segments.contains(where: { $0 == ".." || $0 == "." }) else {
            throw ZipError.unsafePath(name)
        }
        var target = base
        for segment in segments { target.appendPathComponent(String(segment)) }
        guard target.standardizedFileURL.path.hasPrefix(base.path + "/") else { throw ZipError.unsafePath(name) }
        return target
    }

    // MARK: Reading

    static func centralDirectory(_ data: Data) throws -> [Entry] {
        // End of central directory: the last "PK\x05\x06" within 64 KB + 22 of the end.
        guard data.count >= 22 else { throw ZipError.notAZip }
        var eocd = -1
        let floor = max(0, data.count - 65_557)
        var i = data.count - 22
        while i >= floor {
            if data.u32(i) == 0x0605_4B50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ZipError.notAZip }
        let count = Int(data.u16(eocd + 10))
        let cdSize = Int(data.u32(eocd + 12))
        let cdOffset = Int(data.u32(eocd + 16))
        guard count != 0xFFFF, cdOffset != 0xFFFF_FFFF else { throw ZipError.unsupported("zip64") }
        guard count <= maxEntries else { throw ZipError.tooLarge }
        guard cdOffset + cdSize <= eocd else { throw ZipError.corrupt("central directory") }

        var entries: [Entry] = []
        var p = cdOffset
        for _ in 0..<count {
            guard p + 46 <= data.count, data.u32(p) == 0x0201_4B50 else { throw ZipError.corrupt("central header") }
            let flags = data.u16(p + 8)
            let method = data.u16(p + 10)
            let crc = data.u32(p + 16)
            let compressed = Int(data.u32(p + 20))
            let size = Int(data.u32(p + 24))
            let nameLength = Int(data.u16(p + 28))
            let extraLength = Int(data.u16(p + 30))
            let commentLength = Int(data.u16(p + 32))
            let externalAttributes = data.u32(p + 38)
            let offset = Int(data.u32(p + 42))
            guard p + 46 + nameLength <= data.count else { throw ZipError.corrupt("name") }
            let name = String(decoding: data.subdata(in: (p + 46)..<(p + 46 + nameLength)), as: UTF8.self)
            if flags & 0x1 != 0 { throw ZipError.unsupported("encrypted entry") }
            guard method == 0 || method == 8 else { throw ZipError.unsupported("method \(method)") }
            guard compressed != 0xFFFF_FFFF, size != 0xFFFF_FFFF, offset != 0xFFFF_FFFF else { throw ZipError.unsupported("zip64") }
            // Unix mode in the high 16 bits: refuse symlinks (S_IFLNK).
            if (externalAttributes >> 16) & 0o170000 == 0o120000 { throw ZipError.unsafePath(name) }
            entries.append(Entry(name: name, method: method, crc32: crc, compressedSize: compressed, size: size, localHeaderOffset: offset))
            p += 46 + nameLength + extraLength + commentLength
        }
        return entries
    }

    static func contents(of entry: Entry, in data: Data) throws -> Data {
        let p = entry.localHeaderOffset
        guard p + 30 <= data.count, data.u32(p) == 0x0403_4B50 else { throw ZipError.corrupt("local header") }
        let start = p + 30 + Int(data.u16(p + 26)) + Int(data.u16(p + 28))
        guard start + entry.compressedSize <= data.count else { throw ZipError.corrupt("entry bounds") }
        let raw = data.subdata(in: start..<(start + entry.compressedSize))
        let out: Data
        if entry.method == 0 {
            guard entry.compressedSize == entry.size else { throw ZipError.corrupt("stored size") }
            out = raw
        } else {
            out = try inflate(raw, size: entry.size)
        }
        guard crc32(out) == entry.crc32 else { throw ZipError.corrupt("crc \(entry.name)") }
        return out
    }

    /// Raw DEFLATE into exactly `size` bytes.
    static func inflate(_ raw: Data, size: Int) throws -> Data {
        guard size > 0 else { return Data() }
        var out = Data(count: size)
        let written = out.withUnsafeMutableBytes { dst in
            raw.withUnsafeBytes { src in
                compression_decode_buffer(
                    dst.bindMemory(to: UInt8.self).baseAddress!, size,
                    src.bindMemory(to: UInt8.self).baseAddress!, raw.count,
                    nil, COMPRESSION_ZLIB
                )
            }
        }
        guard written == size else { throw ZipError.corrupt("inflate") }
        return out
    }

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { buffer in
            for byte in buffer { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        }
        return crc ^ 0xFFFF_FFFF
    }
}

private extension Data {
    func u16(_ offset: Int) -> UInt16 {
        UInt16(self[startIndex + offset]) | UInt16(self[startIndex + offset + 1]) << 8
    }

    func u32(_ offset: Int) -> UInt32 {
        UInt32(u16(offset)) | UInt32(u16(offset + 2)) << 16
    }
}
