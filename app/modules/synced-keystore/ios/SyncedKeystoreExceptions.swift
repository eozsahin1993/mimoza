import ExpoModulesCore

internal final class KeyChainException: GenericException<OSStatus> {
  override var reason: String {
    if let message = SecCopyErrorMessageString(param, nil) as? String {
      return message
    }
    return "Unknown Keychain error (status \(param))."
  }
}
