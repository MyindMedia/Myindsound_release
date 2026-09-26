import CryptoKit
import Foundation
import Security

/// AUD-3: one 256-bit AES key per signed-in fan, in the Keychain with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (usable for background playback after the first unlock,
/// never in a backup, never on another device). AUD-6 deletes it when the fan has no downloads left.
enum DownloadKeychain {
    static let service = "com.myindsound.downloads.v1"

    enum KeychainError: Error, Equatable { case status(OSStatus) }

    /// The key for `account`, created on first use when `create` is true.
    static func key(account: String, create: Bool) throws -> SymmetricKey? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else { throw KeychainError.status(status) }
        guard create else { return nil }

        let key = SymmetricKey(size: .bits256)
        var add = baseQuery(account)
        add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError.status(added) }
        return key
    }

    static func deleteKey(account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}
