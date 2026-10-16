package com.luyou.planner

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.UserManager
import android.util.Log
import kotlin.concurrent.thread
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class NotificationPlugin(private val activity: android.app.Activity) : Plugin(activity) {
    @InvokeArg
    class ScheduleArgs {
        lateinit var title: String
        lateinit var body: String
        var atMillis: Long = 0
        /** Diagnostics may append a reminder without replacing the active trip. */
        var replaceExisting: Boolean = true
    }

    @InvokeArg
    class CancelArgs {
        lateinit var title: String
        var atMillis: Long = 0
    }

    @Command
    fun schedule(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ScheduleArgs::class.java)
            require(args.title.isNotBlank() && args.body.isNotBlank() && args.atMillis > System.currentTimeMillis())
            require(args.title.length <= 120 && args.body.length <= 500) { "notification content is too long" }
            ensureChannel()
            if (!notificationsEnabled()) {
                NotificationPermissionHelper.requestOrOpenSettings(activity, CHANNEL_ID, NOTIFICATION_REQUEST)
                throw IllegalStateException("请允许通知权限后再保存提醒")
            }
            // 以标题 + 触发时间生成稳定 ID：同一条提醒重新保存时会更新原闹钟，
            // 不同提醒则可以并存，避免固定 requestCode 覆盖用户的其他行程提醒。
            ReminderStore.saveAndSchedule(activity, args.title, args.body, args.atMillis, args.replaceExisting)
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法设置提醒")
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            require(args.title.isNotBlank() && args.atMillis > 0) { "notification is invalid" }
            // Remove the record and its PendingIntent under the same monitor as
            // saveAndSchedule. Match the title/time pair so reminders created by
            // older releases remain cancellable after the ID algorithm changes.
            if (!ReminderStore.cancel(activity, args.title, args.atMillis)) throw IllegalStateException("无法取消提醒")
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法取消提醒")
        }
    }

    @Command
    fun cancelAll(invoke: Invoke) {
        try {
            check(ReminderStore.cancelAll(activity)) { "无法取消提醒" }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法取消提醒")
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "途迹行程提醒", NotificationManager.IMPORTANCE_DEFAULT))
    }

    private fun notificationsEnabled(): Boolean {
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    private companion object {
        const val CHANNEL_ID = "route-trip-reminders"
        const val NOTIFICATION_REQUEST = 7813

    }
}

internal object ReminderStore {
    private const val PREFS = "route_scheduled_reminders"
    private const val KEY = "entries"
    private const val CHANNEL_ID = "route-trip-reminders"

    @Synchronized
    fun saveAndSchedule(context: Context, title: String, body: String, atMillis: Long, replaceExisting: Boolean = true) {
        // The app owns one active trip at a time. Replace the complete stored
        // set so a changed trip cannot leave stale reminders that a reboot
        // would later restore. Persist first; if storage fails, old alarms and
        // records remain intact and the caller can report the failure.
        val previous = read(context)
        val isSameReminder: (org.json.JSONObject) -> Boolean = { old ->
            old.optString("title") == title && old.optLong("atMillis", 0) == atMillis
        }
        // Allocate under the store lock: a colliding persisted ID must never
        // overwrite another reminder or its PendingIntent, even after upgrade.
        val occupied = previous.filterNot(isSameReminder).map { it.optInt("id", 0) }.toSet()
        val id = ReminderIdPolicy.availableId(title, atMillis, occupied)
        val entry = org.json.JSONObject().apply {
            put("id", id)
            put("title", title)
            put("body", body)
            put("atMillis", atMillis)
        }
        val values = if (replaceExisting) {
            listOf(entry)
        } else {
            previous.filterNot { it.optInt("id") == id || isSameReminder(it) } + entry
        }
        val intent = Intent(context, RouteReminderReceiver::class.java).apply {
            putExtra("title", title)
            putExtra("body", body)
            putExtra("notificationId", id)
        }
        val pending = PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        var committed = false
        try {
            val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            // Register the new alarm before committing the replacement record.
            // If storage is full, the old record and its alarms can still be
            // restored instead of leaving a durable reminder with no alarm.
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending)
            if (!write(context, values)) throw IllegalStateException("无法保存提醒")
            committed = true
            if (replaceExisting) {
                // The replacement owns the complete active-trip set. Cancel
                // every previous alarm except the new PendingIntent itself;
                // this also removes same title/time entries written by the
                // legacy hash-based ID algorithm.
                previous.filter { it.optInt("id", 0) != id }
                    .forEach { cancelAlarm(context, it.optInt("id", 0)) }
            } else {
                previous.filter { isSameReminder(it) && it.optInt("id", 0) != id }
                    .forEach { cancelAlarm(context, it.optInt("id", 0)) }
            }
        } catch (error: Exception) {
            if (!committed) {
                // The new record was never committed. Cancel the newly created
                // PendingIntent (or the replaced same-id alarm) and restore the
                // previous alarm set before surfacing the failure.
                cancelAlarm(context, id)
                if (!write(context, previous)) throw IllegalStateException("无法恢复提醒", error)
                previous.forEach { scheduleAlarm(context, it) }
            }
            throw error
        }
    }

    @Synchronized
    fun cancel(context: Context, title: String, atMillis: Long): Boolean {
        // Storage is the source of truth. If it cannot be updated, leave the
        // alarm active so reboot recovery cannot resurrect a half-cancelled
        // reminder. Alarm cancellation happens before releasing the same lock
        // used by saveAndSchedule, closing the replace/cancel race.
        val active = read(context)
        val removed = active.filter {
            it.optString("title") == title && it.optLong("atMillis", 0) == atMillis
        }
        // The receiver may already have consumed the reminder. Cancellation
        // remains idempotent so disabling it does not report a false failure.
        if (removed.isEmpty()) return true
        if (!write(context, active - removed.toSet())) return false
        removed.forEach { entry ->
            val id = entry.optInt("id", 0)
            cancelAlarm(context, id)
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id)
        }
        return true
    }

    @Synchronized
    fun cancelAll(context: Context): Boolean {
        // The app owns the active reminder set. Clear durable state first so a
        // reboot cannot resurrect a reminder if alarm cancellation is delayed.
        val active = read(context)
        if (!write(context, emptyList())) return false
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        active.forEach { entry ->
            cancelAlarm(context, entry.optInt("id", 0))
            manager.cancel(entry.optInt("id", 0))
        }
        return true
    }

    @Synchronized
    fun restore(context: Context) {
        val now = System.currentTimeMillis()
        // read() performs validation and duplicate filtering before cancelling
        // alarms. Do not iterate raw backup entries here: cancelling a duplicate
        // ID while restoring can also cancel the PendingIntent retained for the
        // valid entry when SharedPreferences returns the duplicate first.
        val active = read(context)
        active.forEach { entry ->
            val atMillis = entry.optLong("atMillis", 0)
            if (atMillis > now) {
                val intent = Intent(context, RouteReminderReceiver::class.java).apply {
                    putExtra("title", entry.optString("title"))
                    putExtra("body", entry.optString("body"))
                    putExtra("notificationId", entry.optInt("id", 0))
                }
                val pending = PendingIntent.getBroadcast(
                    context,
                    entry.optInt("id", 0),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending)
            }
        }
        write(context, active)
        // Deliver alarms that elapsed while the device was rebooting or
        // notification access was disabled; keep them stored when access is
        // still unavailable so a later app resume can flush them.
        flushDue(context)
    }

    /** Deliver reminders that elapsed while notification permission/channel was disabled. */
    @Synchronized
    fun flushDue(context: Context) {
        if (!notificationsEnabledForReceiver(context)) return
        val now = System.currentTimeMillis()
        val due = read(context).filter { it.optLong("atMillis", 0) <= now }
        if (due.isEmpty()) return
        due.forEach { entry ->
            showNotificationForReceiver(
                context,
                entry.optInt("id", 7812),
                entry.optString("title").ifBlank { "途迹行程提醒" },
                entry.optString("body").ifBlank { "请打开途迹查看行程" },
            )
        }
        write(context, read(context).filterNot { it.optLong("atMillis", 0) <= now })
    }

    /** Consume one alarm atomically with foreground recovery to avoid duplicates. */
    @Synchronized
    fun deliver(context: Context, notificationId: Int) {
        if (!notificationsEnabledForReceiver(context)) return
        val entries = read(context)
        val entry = entries.firstOrNull { it.optInt("id", 0) == notificationId } ?: return
        showNotificationForReceiver(
            context,
            notificationId,
            entry.optString("title").ifBlank { "途迹行程提醒" },
            entry.optString("body").ifBlank { "请打开途迹查看行程" },
        )
        // Notify first so a transient SharedPreferences failure never suppresses
        // the user-visible reminder. A later foreground recovery may show it once more.
        write(context, entries.filterNot { it.optInt("id", 0) == notificationId })
    }

    internal fun notificationsEnabledForReceiver(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = manager.getNotificationChannel(CHANNEL_ID)
            if (channel?.importance == NotificationManager.IMPORTANCE_NONE) return false
            // Users can delete a channel from system settings. Recreate it before
            // building a notification so a due reminder is not lost or rejected.
            if (channel == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "途迹行程提醒", NotificationManager.IMPORTANCE_DEFAULT)
                )
            }
        }
        return true
    }

    internal fun showNotificationForReceiver(context: Context, notificationId: Int, title: String, body: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") android.app.Notification.Builder(context)
        }
        val openApp = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.notify(notificationId, builder.setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(contentIntent)
            .setAutoCancel(true).build())
    }

    private fun read(context: Context): List<org.json.JSONObject> {
        val seenIds = HashSet<Int>()
        val invalidIds = HashSet<Int>()
        val valid = readRaw(context).filter { entry ->
            val id = entry.optInt("id", 0)
            val accepted = validEntry(
                id,
                entry.optString("title"),
                entry.optString("body"),
                entry.optLong("atMillis", 0),
            ) && seenIds.add(id)
            if (!accepted) invalidIds.add(id)
            accepted
        }
        // Do this after selecting the retained entry. A duplicate ID shares
        // one PendingIntent; cancelling it while processing the duplicate
        // would also cancel the valid record that we keep.
        invalidIds.filter { it == 0 || !seenIds.contains(it) }.forEach { id ->
            // A malformed or duplicate backup entry can still have an
            // AlarmManager PendingIntent from an older run. Remove that alarm
            // at read time, rather than waiting for reboot recovery, so
            // replacing a trip cannot leave silent background wakeups.
            cancelAlarm(context, id)
        }
        return valid
    }

    private fun readRaw(context: Context): List<org.json.JSONObject> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY, emptySet())
            .orEmpty()
            .mapNotNull { raw -> runCatching { org.json.JSONObject(raw) }.getOrNull() }

    private fun validEntry(id: Int, title: String, body: String, atMillis: Long): Boolean =
        id != 0 && title.isNotBlank() && title.length <= 120 &&
            body.isNotBlank() && body.length <= 500 && atMillis > 0

    private fun write(context: Context, values: Iterable<org.json.JSONObject>): Boolean {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putStringSet(KEY, values.map { it.toString() }.toHashSet()).commit()
    }

    private fun cancelAlarm(context: Context, id: Int) {
        if (id == 0) return
        val pending = PendingIntent.getBroadcast(
            context,
            id,
            Intent(context, RouteReminderReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending)
        pending.cancel()
    }

    private fun scheduleAlarm(context: Context, entry: org.json.JSONObject) {
        val id = entry.optInt("id", 0)
        val atMillis = entry.optLong("atMillis", 0)
        if (id == 0 || atMillis <= System.currentTimeMillis()) return
        val intent = Intent(context, RouteReminderReceiver::class.java).apply {
            putExtra("title", entry.optString("title"))
            putExtra("body", entry.optString("body"))
            putExtra("notificationId", id)
        }
        val pending = PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
            .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending)
    }
}

class RouteReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val notificationId = intent.getIntExtra("notificationId", 7812)
        runCatching { ReminderStore.deliver(context, notificationId) }
            .onFailure { Log.w("RouteReminders", "Unable to deliver reminder; kept for foreground recovery", it) }
    }
}

class RouteReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // ReminderStore uses credential-protected SharedPreferences. Restore only
        // after the user-unlocked boot event; reading it during direct boot can
        // look like an empty store and accidentally erase scheduled reminders.
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED ||
            intent.action == Intent.ACTION_USER_UNLOCKED ||
            intent.action == Intent.ACTION_TIME_CHANGED ||
            intent.action == Intent.ACTION_TIMEZONE_CHANGED
        ) {
            // These broadcasts can arrive during direct boot, before
            // credential-protected SharedPreferences are available. Do not
            // treat that temporary empty view as the source of truth: the
            // USER_UNLOCKED broadcast below will perform the real restore.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val userManager = context.getSystemService(UserManager::class.java)
                if (userManager != null && !userManager.isUserUnlocked) return
            }
            val pendingResult = goAsync()
            thread(name = "route-background-restore") {
                try {
                    runCatching { ReminderStore.restore(context) }
                        .onFailure { Log.w("RouteReminders", "Unable to restore reminders", it) }
            // Weather monitoring is stored separately from reminders. Rebuild
            // its WorkManager registration as well so an app replacement or
            // reboot does not wait for the next foreground launch.
                    runCatching { WeatherBackgroundScheduler.restore(context) }
                        .onFailure { Log.w("RouteWeather", "Unable to restore weather monitor", it) }
                } finally {
                    pendingResult.finish()
                }
            }
        }
    }
}
