import * as SecureStore from 'expo-secure-store';

/**
 * Circle content keys. Used to live in the App Group's shared Keychain so
 * the notification service extension could read them; that extension is
 * gone, so this is now a plain per-app Keychain item like any other.
 */
export function getSecret(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export function setSecret(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value);
}

export function deleteSecret(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key);
}
