import CryptoKit
import Foundation
import SwiftSodium

/// The receive half of app/src/services/crypto.ts, ported for the
/// extension's own process. push-crypto-vectors.test.ts pins the exact
/// bytes this must reproduce — check a change here against those.
enum CircleCrypto {
  /// derivePushRoutingId in crypto.ts. The domain string is
  /// "push-enabled" — an earlier design called it "push-routing", but
  /// what shipped is what every device must match, so this follows the
  /// code rather than that name.
  static func pushRoutingId(masterSeed: Data, circleId: String) -> String {
    let info = Data("push-enabled".utf8) + Data(circleId.utf8)
    let key = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: masterSeed),
      salt: Data(),
      info: info,
      outputByteCount: 32
    )
    return key.withUnsafeBytes { Data($0).hexString }
  }

  private static let sodium = Sodium()

  /// decrypt in crypto.ts: nonce(24) || box, no AAD — libsodium's combined
  /// format as-is. CryptoKit has no XChaCha, hence the dependency.
  static func open(_ box: Data, key: Data) -> Data? {
    guard key.count == 32 else { return nil }
    guard let plaintext = sodium.aead.xchacha20poly1305ietf.decrypt(
      nonceAndAuthenticatedCipherText: [UInt8](box),
      secretKey: [UInt8](key)
    ) else { return nil }
    return Data(plaintext)
  }

  /// The signature covers JSON.stringify({type, payload}), and the
  /// envelope serializes those same values first — so the signed bytes are
  /// the plaintext up to its last `,"authorPubkey":"`, plus a closing
  /// brace. Extracted textually because Swift encoders can't reproduce JS
  /// key order. Nil for every way an envelope can be untrustworthy, same
  /// contract as verifyLogEntry in log-entry.ts.
  static func verifyEnvelope(_ plaintext: Data) -> [String: Any]? {
    guard let envelope = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
          envelope["type"] is String,
          let authorHex = envelope["authorPubkey"] as? String,
          let signatureHex = envelope["signature"] as? String,
          let author = Data(hexString: authorHex), author.count == 32,
          let signature = Data(hexString: signatureHex), signature.count == 64,
          let marker = plaintext.range(of: Data(",\"authorPubkey\":\"".utf8), options: .backwards)
    else { return nil }

    var message = plaintext.subdata(in: plaintext.startIndex..<marker.lowerBound)
    message.append(UInt8(ascii: "}"))

    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: author),
          key.isValidSignature(signature, for: message)
    else { return nil }
    return envelope
  }

  /// openSealedBox in primitives.ts: senderPublicKey(32) || nonce(24) || box,
  /// keyed by HKDF over the X25519 secret with both public keys in the info.
  static func openSealed(_ sealed: Data, recipientSecretKey: Data) -> Data? {
    let senderPublicKey = Data(sealed.prefix(32))
    guard sealed.count > 32,
          let secret = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipientSecretKey),
          let sender = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderPublicKey),
          let shared = try? secret.sharedSecretFromKeyAgreement(with: sender)
    else { return nil }
    let info = Data("join-approval-box".utf8) + senderPublicKey + secret.publicKey.rawRepresentation
    let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
    return open(Data(sealed.dropFirst(32)), key: key.withUnsafeBytes { Data($0) })
  }

  /// The creator signs JSON.stringify(approval), which is the envelope's
  /// text between `{"approval":` and its last `,"signature":"`: the same
  /// textual cut as verifyEnvelope, for the same reason.
  static func verifyApproval(_ plaintext: Data, createdByPublicKey: String) -> Bool {
    let prefix = Data("{\"approval\":".utf8)
    guard plaintext.starts(with: prefix),
          let marker = plaintext.range(of: Data(",\"signature\":\"".utf8), options: .backwards),
          let envelope = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any],
          let signatureHex = envelope["signature"] as? String,
          let signature = Data(hexString: signatureHex), signature.count == 64,
          let creator = Data(hexString: createdByPublicKey), creator.count == 32,
          let key = try? Curve25519.Signing.PublicKey(rawRepresentation: creator)
    else { return false }
    let message = plaintext.subdata(in: (plaintext.startIndex + prefix.count)..<marker.lowerBound)
    return key.isValidSignature(signature, for: message)
  }
}

extension Data {
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }

  init?(hexString: String) {
    guard hexString.count % 2 == 0 else { return nil }
    var bytes = [UInt8]()
    bytes.reserveCapacity(hexString.count / 2)
    var index = hexString.startIndex
    while index < hexString.endIndex {
      let next = hexString.index(index, offsetBy: 2)
      guard let byte = UInt8(hexString[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}
