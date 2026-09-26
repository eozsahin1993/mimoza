package expo.modules.pushlocalization

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoHandlingDelegate
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.interfaces.HandlingDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Registered by this module's own AndroidManifest.xml at normal priority,
 * ahead of expo-notifications' own declaration (priority="-1" there) for
 * the same NOTIFICATION_EVENT intent — the same override mechanism
 * LocalizingFirebaseMessagingService uses, via NotificationsService's own
 * designated-receiver lookup (queryBroadcastReceivers, highest priority
 * wins).
 */
class GroupingNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate =
    GroupingPresentationDelegate(context)

  override fun getHandlingDelegate(context: Context): HandlingDelegate =
    GroupingHandlingDelegate(context)
}

/**
 * Every card here is data-only on Android (fcm/sender.go), so
 * expo-notifications' own isDataOnly gate treats it as silent and skips
 * JS's setNotificationHandler while foregrounded. Can't patch that gate —
 * expo-notifications is a prebuilt AAR — so this decides the foreground
 * behavior natively instead, mirroring _layout.tsx's handler exactly. Tap
 * responses and drops still go through a real ExpoHandlingDelegate.
 */
private class GroupingHandlingDelegate(
  private val context: Context,
  private val stock: HandlingDelegate = ExpoHandlingDelegate(context),
) : HandlingDelegate by stock {
  override fun handleNotification(notification: Notification) {
    val content = notification.notificationRequest.content
    if (content.title.isNullOrEmpty() && content.text.isNullOrEmpty()) return

    if (isAppInForeground()) {
      // Mirrors _layout.tsx: no banner while open, still listed and badged.
      NotificationsService.present(
        context,
        notification,
        NotificationBehaviorRecord(shouldShowList = true, shouldSetBadge = true, priority = "default")
      )
    } else {
      NotificationsService.present(context, notification)
    }
  }

  private fun isAppInForeground() =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
}

/**
 * Groups a circle's notifications and posts its own summary card: some
 * OEM skins (confirmed on Samsung/OneUI) never auto-generate the "N new"
 * collapse stock/Pixel Android shows for a same-group set with no summary
 * of its own.
 *
 * expo-notifications exposes no first-class way to reach a push's raw
 * data here, so the circle id rides in content.body instead (fcm/sender.go
 * writes it, NotificationData.kt reads it back).
 */
private class GroupingPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  /**
   * Overridden, not just createNotification: the base class's own
   * presentNotification fires notify() in a coroutine it doesn't hand
   * back, so the summary has to be posted from inside this one to be sure
   * the notification it's summarizing is already active.
   */
  override fun presentNotification(notification: Notification, behavior: NotificationBehaviorRecord?) {
    val circleId = circleId(notification)
    if (circleId == null || behavior?.shouldPresentAlert == false) {
      super.presentNotification(notification, behavior)
      return
    }

    CoroutineScope(Dispatchers.IO).launch {
      val built = createNotification(notification, behavior)
      NotificationManagerCompat.from(context).notify(
        notification.notificationRequest.identifier,
        getNotifyId(notification.notificationRequest),
        built
      )
      // NotificationCompat.getChannelId is the version-safe read;
      // Notification.getChannelId() itself needs API 26, below minSdkVersion 24.
      postSummary(circleId, NotificationCompat.getChannelId(built) ?: "")
    }
  }

  /**
   * NotificationCompat.Builder's (Context, Notification) constructor
   * recovers a builder from an already-built notification, so setGroup
   * can be layered on without reimplementing ExpoNotificationBuilder.build().
   */
  override suspend fun createNotification(
    notification: Notification,
    notificationBehavior: NotificationBehaviorRecord?
  ): android.app.Notification {
    val built = listOnly(super.createNotification(notification, notificationBehavior), notificationBehavior)
    val circleId = circleId(notification) ?: return built
    return NotificationCompat.Builder(context, built).setGroup(circleId).build()
  }

  /**
   * Heads-up on API 26+ is decided by channel importance, not
   * Notification.priority. Only expo-notifications' own anonymous fallback
   * (IMPORTANCE_HIGH, used when channelId doesn't resolve to a real
   * channel yet) gets rerouted here to avoid a banner while foregrounded —
   * a resolved circle/invites channel already sits at whatever importance
   * the user gave it, muted included, and has to keep behaving that way
   * regardless of app state.
   */
  private fun listOnly(
    built: android.app.Notification,
    behavior: NotificationBehaviorRecord?
  ): android.app.Notification {
    if (behavior?.shouldShowBanner != false || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return built
    val importance = NotificationManagerCompat.from(context).getNotificationChannel(built.channelId)?.importance
      ?: NotificationManager.IMPORTANCE_HIGH
    if (importance < NotificationManager.IMPORTANCE_HIGH) return built
    return NotificationCompat.Builder(context, built).setChannelId(listOnlyChannelId()).build()
  }

  private fun listOnlyChannelId(): String {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(LIST_ONLY_CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(LIST_ONLY_CHANNEL_ID, "Notifications", NotificationManager.IMPORTANCE_LOW)
      )
    }
    return LIST_ONLY_CHANNEL_ID
  }

  private fun circleId(notification: Notification): String? =
    notification.notificationRequest.content.body
      ?.optString("circleId")
      ?.takeIf { it.isNotEmpty() }

  /**
   * Mimics stock Android's own auto-summary: nothing below 2 (stock's own
   * threshold), a plain count above it, cancelled once back to one.
   *
   * `channelId` is whatever the individual notification just landed on —
   * a summary on a different channel would skip that circle's own
   * mute/sound settings.
   */
  private fun postSummary(groupKey: String, channelId: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val count = manager.activeNotifications.count {
      it.notification.group == groupKey &&
        it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY == 0
    }
    val tag = SUMMARY_TAG_PREFIX + groupKey
    if (count < 2) {
      NotificationManagerCompat.from(context).cancel(tag, 0)
      return
    }

    val text = context.resources.getIdentifier("push_group_summary", "string", context.packageName)
      .takeIf { it != 0 }
      ?.let { context.getString(it, count) }

    val summary = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(icon)
      .setContentText(text)
      .setGroup(groupKey)
      .setGroupSummary(true)
      .setAutoCancel(true)
      .also { builder -> color?.let { builder.setColor(it) } }
      .build()

    NotificationManagerCompat.from(context).notify(tag, 0, summary)
  }

  // Mirrors BaseNotificationBuilder's own meta-data lookup (unreachable
  // from here), so the summary's icon/color match the individual cards'.
  private val icon: Int
    get() = metaData()?.let {
      it.getInt(META_DATA_ICON_KEY).takeIf { id -> id != 0 }
    } ?: context.applicationInfo.icon

  private val color: Int?
    get() = metaData()?.let {
      it.getInt(META_DATA_COLOR_KEY).takeIf { id -> id != 0 }
    }?.let { context.getColor(it) }

  private fun metaData() = try {
    context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
  } catch (e: PackageManager.NameNotFoundException) {
    null
  }

  companion object {
    private const val SUMMARY_TAG_PREFIX = "circle-summary:"
    private const val LIST_ONLY_CHANNEL_ID = "expo_notifications_list_only_channel"
    private const val META_DATA_ICON_KEY = "expo.modules.notifications.default_notification_icon"
    private const val META_DATA_COLOR_KEY = "expo.modules.notifications.default_notification_color"
  }
}
