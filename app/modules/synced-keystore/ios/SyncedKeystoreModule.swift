import ExpoModulesCore
import Security

public final class SyncedKeystoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SyncedKeystore")

    AsyncFunction("setSynced") { (key: String, value: String) -> String in
      try self.set(key: key, value: value)
      return value
    }

    AsyncFunction("getSynced") { (key: String) -> String? in
      try self.get(key: key)
    }

    AsyncFunction("deleteSynced") { (key: String) in
      try self.delete(key: key)
    }
  }

  // No accessGroup: this deliberately lands in the app's own default
  // keychain group rather than the shared APP_GROUP from store.ts.
  // Combining an App Group access group with kSecAttrSynchronizable is
  // undocumented by Apple, so this avoids the combination rather than
  // guessing at it — an app-default-group item with no accessGroup set
  // is the well-precedented way to sync a generic password.
  private func baseQuery(key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "synced-keystore",
      kSecAttrAccount as String: key,
    ]
  }

  // errSecSuccess means the local Keychain took it, not that iCloud has
  // propagated it anywhere — that hand-off is entirely up to the OS.
  private func set(key: String, value: String) throws {
    var add = baseQuery(key: key)
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrSynchronizable as String] = true
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

    let status = SecItemAdd(add as CFDictionary, nil)
    print("[SyncedKeystore] set \(key): SecItemAdd status \(status)")
    if status == errSecDuplicateItem {
      var search = baseQuery(key: key)
      search[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
      let update: [String: Any] = [kSecValueData as String: Data(value.utf8)]
      let updateStatus = SecItemUpdate(search as CFDictionary, update as CFDictionary)
      print("[SyncedKeystore] set \(key): SecItemUpdate status \(updateStatus)")
      guard updateStatus == errSecSuccess else { throw KeyChainException(updateStatus) }
      return
    }
    guard status == errSecSuccess else { throw KeyChainException(status) }
  }

  private func get(key: String) throws -> String? {
    var query = baseQuery(key: key)
    // Omitting kSecAttrSynchronizable here would match local-only items,
    // silently missing anything iCloud Keychain synced in from another
    // device — search and delete both need this; only add doesn't.
    query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    print("[SyncedKeystore] get \(key): SecItemCopyMatching status \(status)")
    switch status {
    case errSecSuccess:
      guard let data = item as? Data else { return nil }
      return String(data: data, encoding: .utf8)
    case errSecItemNotFound:
      return nil
    default:
      throw KeyChainException(status)
    }
  }

  private func delete(key: String) throws {
    var query = baseQuery(key: key)
    query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    let status = SecItemDelete(query as CFDictionary)
    print("[SyncedKeystore] delete \(key): SecItemDelete status \(status)")
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeyChainException(status)
    }
  }
}
