Pod::Spec.new do |s|
  s.name           = 'SyncedKeystore'
  s.version        = '1.0.0'
  s.summary        = 'Syncs a secret through iCloud Keychain'
  s.description    = 'Local module backing the account keypair\'s cross-device sync via kSecAttrSynchronizable, which expo-secure-store does not expose.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
