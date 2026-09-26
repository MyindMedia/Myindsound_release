import Foundation

/// Any Convex value, decoded without a schema. The app's API mapping reads fields out of it by name, so a
/// renamed, missing or extra field in a Convex return degrades to a default instead of failing the whole
/// decode (docs/app-v1/API.md was still being written when this was built, BUILD.md).
///
/// Convex's JSON export format carries int64 as `{"$integer": "<base64 little endian>"}` and non-finite
/// floats as `{"$float": "<base64>"}`; `double` reads both.
enum JSONValue: Decodable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }

    static func parse(_ string: String) throws -> JSONValue {
        try parse(Data(string.utf8))
    }

    // MARK: Access

    subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    /// The first of `keys` that is present and not null.
    func first(_ keys: String...) -> JSONValue? {
        for key in keys {
            if let value = self[key], value != .null { return value }
        }
        return nil
    }

    var isNull: Bool { self == .null }

    var string: String? {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        default: return nil
        }
    }

    var double: Double? {
        switch self {
        case .number(let value): return value
        case .string(let value): return Double(value)
        case .bool(let value): return value ? 1 : 0
        case .object(let object):
            if case .string(let b64)? = object["$integer"], let data = Data(base64Encoded: b64), data.count == 8 {
                return Double(data.withUnsafeBytes { $0.loadUnaligned(as: Int64.self) }.littleEndian)
            }
            if case .string(let b64)? = object["$float"], let data = Data(base64Encoded: b64), data.count == 8 {
                return data.withUnsafeBytes { Double(bitPattern: $0.loadUnaligned(as: UInt64.self).littleEndian) }
            }
            return nil
        default: return nil
        }
    }

    var int: Int? { double.flatMap { $0.isFinite ? Int($0.rounded()) : nil } }

    var bool: Bool? {
        switch self {
        case .bool(let value): return value
        case .number(let value): return value != 0
        case .string(let value): return ["true", "1", "yes"].contains(value.lowercased())
        default: return nil
        }
    }

    var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// Epoch milliseconds (Convex's `Date.now()`) as a Date. ISO 8601 strings are accepted too.
    var date: Date? {
        if let ms = double, ms > 0 { return Date(timeIntervalSince1970: ms / 1000) }
        if let text = string { return ISO8601DateFormatter().date(from: text) }
        return nil
    }
}
