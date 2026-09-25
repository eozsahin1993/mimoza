package expo.modules.pushlocalization

import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.interfaces.FirebaseMessagingDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate as StockDelegate

/**
 * Registered by this module's own AndroidManifest.xml at normal priority,
 * ahead of expo-notifications' own declaration (priority="-1" there, on
 * purpose) for the same MESSAGING_EVENT intent, so this is the one FCM
 * actually delivers to.
 *
 * expo-notifications only ever reads a message's literal `notification.title`
 * / `.body`, or a plain `data.title` / `data.message` — never FCM's own
 * title_loc_key/body_loc_key mechanism the relay actually sends (see the
 * relay's push/compose.go and push/fcm/sender.go); see
 * https://github.com/expo/expo/issues/7961, open since 2020, for the
 * library's own stance on this — safe to remove this module (and drop the
 * relay back to sending literal text there) if that ever changes.
 */
class LocalizingFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override val firebaseMessagingDelegate: FirebaseMessagingDelegate by lazy {
    LocalizingDelegate(this, StockDelegate(this))
  }
}

/**
 * Resolves a message's title_loc_key/body_loc_key against this app's own
 * strings.xml, the same way Play Services would for a killed app, then
 * hands a message carrying literal data.title/data.message to the stock
 * delegate, unchanged otherwise. Tap-routing and background tasks read
 * the same `data` map either way (see RemoteMessageSerializer), so
 * nothing about them needs to know this happened.
 *
 * A message with no loc-key at all — a silent roster nudge, which never
 * carries a `notification` block — passes through completely untouched.
 */
private class LocalizingDelegate(
  private val context: Context,
  private val stock: FirebaseMessagingDelegate,
) : FirebaseMessagingDelegate by stock {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    stock.onMessageReceived(resolved(remoteMessage))
  }

  private fun resolved(remoteMessage: RemoteMessage): RemoteMessage {
    val notification = remoteMessage.notification ?: return remoteMessage
    val title = resolve(notification.titleLocalizationKey, notification.titleLocalizationArgs)
    val body = resolve(notification.bodyLocalizationKey, notification.bodyLocalizationArgs)
    if (title == null && body == null) return remoteMessage

    val builder = RemoteMessage.Builder(remoteMessage.to ?: context.packageName)
    remoteMessage.messageId?.let { builder.setMessageId(it) }
    // .data (Kotlin's synthesized property) fails to resolve here with
    // an ambiguous-iterator error; the explicit Java call sidesteps it.
    for ((key, value) in remoteMessage.getData()) builder.addData(key, value)
    title?.let { builder.addData("title", it) }
    body?.let { builder.addData("message", it) }
    return builder.build()
  }

  /** Android's own resource compiler rejects a "." in a string resource's name — the relay already names these without one (see androidResourceName in fcm/sender.go), so no translation is needed here. */
  private fun resolve(key: String?, args: Array<String>?): String? {
    key ?: return null
    val resId = context.resources.getIdentifier(key, "string", context.packageName)
    if (resId == 0) return null
    return context.getString(resId, *(args ?: emptyArray()))
  }
}
