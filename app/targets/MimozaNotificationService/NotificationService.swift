import Foundation
import Security
import UserNotifications

// Written into this extension's Info.plist by expo-target.config.js, so
// staging and production don't share a container — one group across both
// would mean each reading the other's Keychain and snapshot. The fallback
// only matters if that key ever goes missing.
let appGroup = Bundle.main.object(forInfoDictionaryKey: "MimozaAppGroup") as? String ?? "group.com.eozsahin.mimoza"

/// The extension's copy, from Localizable.xcstrings — keys and wording
/// mirror push.ts in the app, and push-copy-parity.test.ts holds them
/// together. Nothing here is ever read from the payload: a push that can't
/// be decrypted must not choose its own lock-screen text.
private struct Strings {
  let bundle: Bundle

  /// The language picked in the app, or nil to follow the device — which
  /// is what the main bundle already does.
  init(language: String?) {
    bundle = language
      .flatMap { Bundle.main.path(forResource: $0, ofType: "lproj") }
      .flatMap(Bundle.init(path:)) ?? .main
  }

  func callAsFunction(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: bundle.localizedString(forKey: key, value: nil, table: nil), arguments: arguments)
  }
}

class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler handler: @escaping (UNNotificationContent) -> Void
  ) {
    contentHandler = handler
    content = request.content.mutableCopy() as? UNMutableNotificationContent
    guard let content else {
      handler(request.content)
      return
    }

    let snapshot = readSnapshot()
    let strings = Strings(language: snapshot?.language)
    content.title = ""
    content.body = strings("push.placeholder")
    // The relay names the address's kind. Invite pushes aren't decrypted
    // here yet (that needs the invite code), so the kind alone picks the line.
    switch request.content.userInfo["kind"] as? String {
    case "invite": content.body = strings("push.joinRequestAnyCircle")
    case "pending_request": content.body = strings("push.joinApprovedAnyCircle")
    default: break
    }
    if let snapshot, let composed = compose(userInfo: request.content.userInfo, snapshot: snapshot, strings: strings) {
      content.title = composed.title
      content.body = composed.body
      content.threadIdentifier = composed.circleId
    }
    handler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content {
      contentHandler(content)
    }
  }

  /// One decrypted, verified push — what composing a card needs.
  private struct DecryptedPush {
    let circle: SnapshotCircle
    let type: String
    let payload: [String: Any]?
    let authorPubkey: String
  }

  /// The native mirror of handle-push.ts's decrypt half. Nil for every
  /// failure — the placeholder stands.
  private func decrypt(userInfo: [AnyHashable: Any], circles: [SnapshotCircle]) -> DecryptedPush? {
    guard let routingId = userInfo["pushRoutingId"] as? String,
          let payloadB64 = userInfo["payload"] as? String,
          let box = Data(base64Encoded: payloadB64),
          let keyVersion = keyVersion(from: userInfo["keyVersion"]),
          let (circle, key) = contentKey(routingId: routingId, keyVersion: keyVersion, circles: circles),
          let plaintext = CircleCrypto.open(box, key: key),
          let envelope = CircleCrypto.verifyEnvelope(plaintext),
          let type = envelope["type"] as? String,
          let authorPubkey = envelope["authorPubkey"] as? String
    else { return nil }
    return DecryptedPush(
      circle: circle,
      type: type,
      payload: envelope["payload"] as? [String: Any],
      authorPubkey: authorPubkey
    )
  }

  /// describeEntry in handle-push.ts. Nil for types that shouldn't raise
  /// a card — but iOS can't suppress a delivered alert, so the
  /// placeholder is the quietest outcome available.
  private func compose(
    userInfo: [AnyHashable: Any],
    snapshot: Snapshot,
    strings: Strings
  ) -> (title: String, body: String, circleId: String)? {
    guard let push = decrypt(userInfo: userInfo, circles: snapshot.circles) else { return nil }

    let body: String
    switch push.type {
    case "member_added":
      // The author is the approving admin; the joiner's name is in the payload.
      let joined = (push.payload?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      body = strings("push.joined", joined ?? strings("push.someone"))
    case "post", "comment", "reaction":
      let member = push.circle.members.first { $0.identityPublicKey == push.authorPubkey }
      let name = (member?.name).flatMap { $0.isEmpty ? nil : $0 } ?? strings("push.someone")
      switch push.type {
      case "post": body = strings("push.post", name)
      case "comment":
        let text = (push.payload?["body"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let key: String
        if let postAuthor = push.payload?["postAuthorPubkey"] as? String {
          key = postAuthor == ownIdentityPubkey(circleId: push.circle.id) ? "push.commentOnYours" : "push.alsoCommented"
        } else {
          key = "push.comment"
        }
        body = text.map { strings(key + "WithText", name, $0) } ?? strings(key, name)
      default:
        if let emoji = push.payload?["emoji"] as? String, !emoji.isEmpty {
          body = strings("push.reactionWithEmoji", name, emoji)
        } else {
          body = strings("push.reaction", name)
        }
      }
    default:
      return nil
    }

    return (title: push.circle.name, body: body, circleId: push.circle.id)
  }

  /// Everything this device holds that one push needs: which circle the
  /// routing id names (recomputed per circle, same as circleForRoutingId
  /// in handle-push.ts — there is no stored map, by design), and that
  /// circle's content key at the entry's version.
  private func contentKey(routingId: String, keyVersion: Int, circles: [SnapshotCircle]) -> (circle: SnapshotCircle, key: Data)? {
    guard let seedHex = readKeychain(account: "master_seed"),
          let seed = Data(hexString: seedHex),
          let circle = circles.first(where: {
            CircleCrypto.pushRoutingId(masterSeed: seed, circleId: $0.id) == routingId
          }),
          let keyMapJSON = readKeychain(account: "circle_keys_\(circle.id)"),
          let keyMap = (try? JSONSerialization.jsonObject(with: Data(keyMapJSON.utf8))) as? [String: String],
          let keyHex = keyMap[String(keyVersion)],
          let key = Data(hexString: keyHex)
    else { return nil }
    return (circle, key)
  }

  /// This device's own signing key for a circle, from the same shared
  /// keychain item keystore.ts writes (circle_identity_<circleId>).
  private func ownIdentityPubkey(circleId: String) -> String? {
    guard let json = readKeychain(account: "circle_identity_\(circleId)"),
          let record = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    else { return nil }
    return record["publicKey"] as? String
  }

  private func keyVersion(from value: Any?) -> Int? {
    if let number = value as? NSNumber { return number.intValue }
    if let string = value as? String { return Int(string) }
    return nil
  }

  /// Matches expo-secure-store's item shape (its SecureStoreModule.swift):
  /// generic password, service "app:no-auth", account = the key.
  /// keystore.ts writes into the shared group with these attributes.
  private func readKeychain(account: String) -> String? {
    for service in ["app:no-auth", "app"] {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: Data(account.utf8),
        kSecAttrAccessGroup as String: appGroup,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
      ]
      var item: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
        return String(data: data, encoding: .utf8)
      }
    }
    return nil
  }

  private struct Snapshot: Decodable {
    let circles: [SnapshotCircle]
    /// Absent when the app follows the device's language.
    let language: String?
  }
  private struct SnapshotCircle: Decodable {
    let id: String
    let name: String
    let members: [SnapshotMember]
  }
  private struct SnapshotMember: Decodable {
    let identityPublicKey: String
    let name: String
  }

  /// The circle/member names and language mirror written by push-snapshot.ts.
  private func readSnapshot() -> Snapshot? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
          let data = try? Data(contentsOf: container.appendingPathComponent("push-snapshot.json")),
          let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
    else { return nil }
    return snapshot
  }
}
