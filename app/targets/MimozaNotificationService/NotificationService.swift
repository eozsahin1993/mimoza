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

    let push = Push(request.content.userInfo)
    let snapshot = readSnapshot()
    let strings = Strings(language: snapshot?.language)
    content.title = ""
    content.body = strings("push.placeholder")
    // The relay names the address's kind. Its line stands when nothing
    // better can be composed.
    var composed: (title: String, body: String, circleId: String)?
    switch push.kind {
    case "invite":
      content.body = strings("push.joinRequestAnyCircle")
      composed = snapshot.flatMap { composeJoinRequest(push, snapshot: $0, strings: strings) }
    case "pending_request":
      content.body = strings("push.joinApprovedAnyCircle")
      composed = snapshot.flatMap { composeApproval(push, snapshot: $0, strings: strings) }
    case "circle":
      composed = snapshot.flatMap { compose(push, snapshot: $0, strings: strings) }
    default:
      break
    }
    if let composed {
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

  /// What every kind reads off a delivered push. The relay names `kind`
  /// from the recipient's own row; `keyVersion` only circle pushes carry.
  private struct Push {
    let kind: String?
    let routingId: String?
    let payload: Data?
    let keyVersion: Int?

    init(_ userInfo: [AnyHashable: Any]) {
      kind = userInfo["kind"] as? String
      routingId = userInfo["pushRoutingId"] as? String
      payload = (userInfo["payload"] as? String).flatMap { Data(base64Encoded: $0) }
      switch userInfo["keyVersion"] {
      case let number as NSNumber: keyVersion = number.intValue
      case let string as String: keyVersion = Int(string)
      default: keyVersion = nil
      }
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
  private func decrypt(_ push: Push, circles: [SnapshotCircle]) -> DecryptedPush? {
    guard let routingId = push.routingId,
          let box = push.payload,
          let keyVersion = push.keyVersion,
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
    _ delivered: Push,
    snapshot: Snapshot,
    strings: Strings
  ) -> (title: String, body: String, circleId: String)? {
    guard let push = decrypt(delivered, circles: snapshot.circles) else { return nil }

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

  /// describeJoinRequest in handle-push.ts: "Priya wants to join" under the
  /// invite's circle, or "Someone" if the payload doesn't open.
  private func composeJoinRequest(
    _ push: Push,
    snapshot: Snapshot,
    strings: Strings
  ) -> (title: String, body: String, circleId: String)? {
    guard let routingId = push.routingId,
          let invite = snapshot.invites?.first(where: { $0.pushRoutingId == routingId }),
          let circle = snapshot.circles.first(where: { $0.id == invite.circleId })
    else { return nil }

    let name = requesterName(push.payload, routingId: routingId) ?? strings("push.someone")
    return (title: circle.name, body: strings("push.joinRequest", name), circleId: circle.id)
  }

  /// readJoinRequestPush in invite-push.ts, with the key keystore.ts wrote
  /// (invite_join_request_key_<routingId>). Capped at 40: the sender chose it.
  private func requesterName(_ box: Data?, routingId: String) -> String? {
    guard let box,
          let keyHex = readKeychain(account: "invite_join_request_key_\(routingId)"),
          let key = Data(hexString: keyHex),
          let plaintext = CircleCrypto.open(box, key: key),
          let payload = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
          let name = payload["selfReportedName"] as? String
    else { return nil }
    let shown = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
    return shown.isEmpty ? nil : shown
  }

  /// describeJoinApproval in handle-push.ts: under the request's circle,
  /// "Emre accepted your request" only once the sealed approval opens with
  /// the request's keypair and the creator's signature holds. Anyone with
  /// the code can send this push, so anything less says only there's news.
  private func composeApproval(
    _ push: Push,
    snapshot: Snapshot,
    strings: Strings
  ) -> (title: String, body: String, circleId: String)? {
    guard let routingId = push.routingId,
          let request = snapshot.pendingRequests?.first(where: { $0.pushRoutingId == routingId })
    else { return nil }

    let body: String
    if !approvalVerifies(push.payload, request: request) {
      body = strings("push.joinRequestNews")
    } else if request.createdByName.isEmpty {
      body = strings("push.joinApprovedNoName")
    } else {
      body = strings("push.joinApproved", String(request.createdByName.trimmingCharacters(in: .whitespaces).prefix(40)))
    }
    return (title: request.circleName, body: body, circleId: request.circleId)
  }

  /// checkPendingJoinRequest's gate, with the keypair keystore.ts wrote
  /// (pending_join_keypair_<requestId>).
  private func approvalVerifies(_ sealed: Data?, request: SnapshotPendingRequest) -> Bool {
    guard let sealed,
          let secretHex = readKeychainRecord(account: "pending_join_keypair_\(request.requestId)")?["secretKey"] as? String,
          let secret = Data(hexString: secretHex),
          let plaintext = CircleCrypto.openSealed(sealed, recipientSecretKey: secret)
    else { return false }
    return CircleCrypto.verifyApproval(plaintext, createdByPublicKey: request.createdByPublicKey)
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
          let keyHex = readKeychainRecord(account: "circle_keys_\(circle.id)")?[String(keyVersion)] as? String,
          let key = Data(hexString: keyHex)
    else { return nil }
    return (circle, key)
  }

  /// This device's own signing key for a circle, from the same shared
  /// keychain item keystore.ts writes (circle_identity_<circleId>).
  private func ownIdentityPubkey(circleId: String) -> String? {
    readKeychainRecord(account: "circle_identity_\(circleId)")?["publicKey"] as? String
  }


  /// A Keychain item keystore.ts wrote as a JSON object (a keypair, a key map).
  private func readKeychainRecord(account: String) -> [String: Any]? {
    readKeychain(account: account)
      .flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any]
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
    let invites: [SnapshotInvite]?
    let pendingRequests: [SnapshotPendingRequest]?
    /// Absent when the app follows the device's language.
    let language: String?
  }
  private struct SnapshotInvite: Decodable {
    let pushRoutingId: String
    let circleId: String
  }
  private struct SnapshotPendingRequest: Decodable {
    let requestId: String
    let pushRoutingId: String
    let circleId: String
    let circleName: String
    let createdByName: String
    let createdByPublicKey: String
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
