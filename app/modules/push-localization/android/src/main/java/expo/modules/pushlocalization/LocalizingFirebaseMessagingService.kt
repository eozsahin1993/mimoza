package expo.modules.pushlocalization

import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.interfaces.FirebaseMessagingDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate as StockDelegate
import org.json.JSONArray

/**
 * Registered by this module's own AndroidManifest.xml at normal priority,
 * ahead of expo-notifications' own declaration (priority="-1" there), so
 * this is the one FCM actually delivers to.
 *
 * Every card ships data-only (see fcm/sender.go): FCM's notification
 * block bypasses the app whenever it isn't foregrounded, which breaks
 * both loc-key resolution and grouping by circle (see
 * GroupingNotificationsService) — so titleLocKey/bodyLocKey/locArgs ride
 * as plain data fields instead, resolved here.
 */
class LocalizingFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override val firebaseMessagingDelegate: FirebaseMessagingDelegate by lazy {
    LocalizingDelegate(this, StockDelegate(this))
  }
}

/**
 * Resolves titleLocKey/bodyLocKey (see fcm/sender.go's
 * androidNotificationData) against this app's own strings.xml, then
 * hands the stock delegate a message carrying literal data.title/
 * data.message — unchanged otherwise, so tap-routing and background
 * tasks (which read the same `data` map) don't need to know this
 * happened.
 *
 * A silent roster nudge has no loc key at all, so it passes through
 * untouched and is never presented — title-and-body-less is "nothing to
 * show" both here and to setNotificationHandler.
 */
private class LocalizingDelegate(
  private val context: Context,
  private val stock: FirebaseMessagingDelegate,
) : FirebaseMessagingDelegate by stock {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    stock.onMessageReceived(resolved(remoteMessage))
  }

  private fun resolved(remoteMessage: RemoteMessage): RemoteMessage {
    val data = remoteMessage.data
    val args = data["locArgs"]?.let(::parseArgs)
    val title = resolve(data["titleLocKey"], args)
    val body = resolve(data["bodyLocKey"], args)
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

  // Already underscored by the relay (androidResourceName in
  // fcm/sender.go), since aapt2 rejects a "." in a resource name.
  private fun resolve(key: String?, args: Array<String>?): String? {
    if (key.isNullOrEmpty()) return null
    val resId = context.resources.getIdentifier(key, "string", context.packageName)
    if (resId == 0) return null
    return context.getString(resId, *(args ?: emptyArray()))
  }

  private fun parseArgs(json: String): Array<String> {
    val array = JSONArray(json)
    return Array(array.length()) { array.getString(it) }
  }
}
