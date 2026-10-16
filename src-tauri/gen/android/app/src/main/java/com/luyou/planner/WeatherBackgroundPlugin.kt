package com.luyou.planner

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.UserManager
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.BackoffPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlin.concurrent.thread

private object WeatherBackgroundLock
private const val MAX_MONITOR_DATES = 31
private const val WEATHER_NOTIFICATION_ID = 7814

private fun cancelWeatherNotification(context: Context) {
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .cancel(WEATHER_NOTIFICATION_ID)
}

/** Shared WorkManager registration used by the JS command and boot receiver. */
internal object WeatherBackgroundScheduler {
    private const val PREFS = "route_weather_background"
    private const val WORK_NAME = "route-weather-risk-monitor"
    private const val IMMEDIATE_WORK_NAME = "route-weather-risk-monitor-now"

    /** Wait for database registration off the main thread before reporting success. */
    fun enqueue(context: Context, includeImmediate: Boolean = true, keepPeriodic: Boolean = false) {
        val periodic = PeriodicWorkRequestBuilder<WeatherRiskWorker>(6, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        val immediate = OneTimeWorkRequestBuilder<WeatherRiskWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        val workManager = WorkManager.getInstance(context)
        synchronized(WeatherBackgroundLock) {
            workManager.enqueueUniquePeriodicWork(
                WORK_NAME,
                if (keepPeriodic) ExistingPeriodicWorkPolicy.KEEP else ExistingPeriodicWorkPolicy.UPDATE,
                periodic,
            ).result.get()
            if (includeImmediate) {
                // A new trip or a post-boot restore should check once now;
                // REPLACE prevents a stale one-shot from running alongside it.
                workManager.enqueueUniqueWork(IMMEDIATE_WORK_NAME, ExistingWorkPolicy.REPLACE, immediate).result.get()
            }
        }
    }

    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        synchronized(WeatherBackgroundLock) {
            workManager.cancelUniqueWork(WORK_NAME).result.get()
            workManager.cancelUniqueWork(IMMEDIATE_WORK_NAME).result.get()
        }
    }

    /** Read both durable configuration and the actual database, without enqueuing work. */
    fun status(context: Context): Map<String, Any> = synchronized(WeatherBackgroundLock) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val destination = prefs.getString("destination", "").orEmpty()
        val rawDates = runCatching {
            val array = JSONArray(prefs.getString("dates", "[]"))
            (0 until array.length()).map { array.optString(it) }
        }.getOrDefault(emptyList())
        val valid = destination.isNotBlank() && destination.length <= 120 &&
            !prefs.getString("generation", null).isNullOrBlank() &&
            rawDates.isNotEmpty() && rawDates.size <= MAX_MONITOR_DATES &&
            rawDates.distinct().size == rawDates.size && rawDates.all(WeatherMonitorPolicy::isCalendarDate)
        val manager = WorkManager.getInstance(context)
        fun work(name: String): List<Map<String, Any>> = manager.getWorkInfosForUniqueWork(name)
            .get(10, TimeUnit.SECONDS).filterNot { it.state.isFinished }.map {
                mapOf("state" to it.state.name, "attempts" to it.runAttemptCount)
            }
        mapOf(
            "configured" to valid,
            "expired" to (valid && WeatherMonitorPolicy.isExpired(rawDates, System.currentTimeMillis())),
            "destination" to destination,
            "dates" to rawDates,
            "periodic" to work(WORK_NAME),
            "immediate" to work(IMMEDIATE_WORK_NAME),
        )
    }

    /** Re-register persisted work after boot, unlock, package replacement, or clock changes. */
    fun restore(context: Context) {
        synchronized(WeatherBackgroundLock) {
            val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val destination = preferences.getString("destination", null)
            val generation = preferences.getString("generation", null)
            val rawDates = runCatching {
                val array = JSONArray(preferences.getString("dates", "[]"))
                (0 until array.length()).map { array.optString(it) }
            }.getOrDefault(emptyList())
            val dates = rawDates.filter(WeatherMonitorPolicy::isCalendarDate).distinct().take(MAX_MONITOR_DATES)
            val invalid = destination.isNullOrBlank() || destination.length > 120 || generation.isNullOrBlank() ||
                dates.isEmpty() || rawDates.size != dates.size
            if (invalid || WeatherMonitorPolicy.isExpired(dates, System.currentTimeMillis())) {
                // WorkManager may restore a periodic request even when the
                // preference file was partially restored or the trip ended
                // while the app was stopped. Remove both sides of the state so
                // an invalid worker cannot keep waking up forever.
                runCatching { preferences.edit().clear().commit() }
                cancel(context)
                cancelWeatherNotification(context)
                return
            }
            enqueue(context, includeImmediate = true, keepPeriodic = true)
        }
    }
}

/** Periodic weather risk monitor. WorkManager survives app process death and reboot. */
@TauriPlugin
class WeatherBackgroundPlugin(private val activity: android.app.Activity) : Plugin(activity) {
    @Command
    fun status(invoke: Invoke) {
        thread(name = "route-weather-status") {
            try {
                invoke.resolveObject(WeatherBackgroundScheduler.status(activity) +
                    mapOf("notificationsEnabled" to notificationsEnabled()))
            } catch (error: Exception) {
                invoke.reject(error.message ?: "无法读取天气后台状态")
            }
        }
    }

    @InvokeArg
    class ScheduleArgs {
        lateinit var destination: String
        var dates: ArrayList<String> = arrayListOf()
        /** Only a new trip/configuration should force an immediate one-shot check. */
        var immediate: Boolean = true
    }

    @Command
    fun schedule(invoke: Invoke) {
        thread(name = "route-weather-schedule") {
            try {
                val args = invoke.parseArgs(ScheduleArgs::class.java)
                require(args.destination.isNotBlank() && args.destination.length <= 120) { "destination is invalid" }
                // Do not silently drop malformed, duplicated, or excess dates:
                // doing so would leave the durable monitor watching only a
                // subset of the trip while the UI still shows the full plan.
                val dates = WeatherMonitorPolicy.validateScheduleDates(args.dates, MAX_MONITOR_DATES)
                val preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                ensureChannel()
                if (!notificationsEnabled()) {
                    NotificationPermissionHelper.requestOrOpenSettings(activity, CHANNEL_ID, NOTIFICATION_REQUEST)
                    throw IllegalStateException("请允许通知权限后再开启天气提醒")
                }
                val generation = UUID.randomUUID().toString()
                synchronized(WeatherBackgroundLock) {
                    val oldDestination = preferences.getString("destination", null)
                    val oldDates = preferences.getString("dates", null)
                    val oldLastAlert = preferences.getString("lastAlert", null)
                    val oldGeneration = preferences.getString("generation", null)
                    val changed = oldDestination != args.destination.trim() || oldDates != JSONArray(dates).toString() || oldGeneration.isNullOrBlank()
                    val editor = preferences.edit().putString("destination", args.destination.trim())
                        .putString("dates", JSONArray(dates).toString())
                        .putString("generation", if (changed) generation else oldGeneration)
                    // A changed trip must be eligible for a fresh alert even
                    // when its first risky date happens to produce the same
                    // destination/date/code signature as the previous trip.
                    // The old value is retained separately for transactional
                    // rollback if WorkManager registration fails below.
                    if (changed) editor.remove("lastAlert")
                    check(editor.commit()) {
                        "无法保存天气监测设置"
                    }
                    try {
                        // A new trip gets a fresh one-shot check even when the old
                        // check is still running, followed by the periodic monitor.
                        if (WeatherMonitorPolicy.isExpired(dates, System.currentTimeMillis())) {
                            // Do not leave an expired configuration behind. A stale
                            // preference can be copied by backup/restore and makes
                            // diagnostics report a monitor that can never run again.
                            check(preferences.edit().clear().commit()) {
                                "无法清除已结束的天气监测设置"
                            }
                            WeatherBackgroundScheduler.cancel(activity)
                            cancelWeatherNotification(activity)
                        } else {
                            // A changed destination/date set must not leave an
                            // alert for the previous trip in the notification
                            // shade while the new worker is being registered.
                            if (changed) cancelWeatherNotification(activity)
                            WeatherBackgroundScheduler.enqueue(activity, includeImmediate = args.immediate || changed, keepPeriodic = !changed)
                        }
                    } catch (error: Exception) {
                        // The one-shot request may already have been accepted before
                        // periodic work fails. Remove it before restoring the old
                        // generation so it cannot run against a stale configuration.
                        runCatching { WeatherBackgroundScheduler.cancel(activity) }
                        restorePreferencesLocked(preferences, oldDestination, oldDates, oldLastAlert, oldGeneration)
                        // Re-register the previous monitor after a failed
                        // replacement. The old durable settings are still valid;
                        // leaving WorkManager cancelled here would make the UI
                        // report a saved monitor that never runs again.
                        runCatching { WeatherBackgroundScheduler.restore(activity) }
                        throw error
                    }
                }
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject(error.message ?: "无法开启天气后台监测")
            }
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        thread(name = "route-weather-cancel") {
            try {
                synchronized(WeatherBackgroundLock) {
                    val preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    // Clear the durable configuration first. If WorkManager throws,
                    // a leftover worker will observe an empty configuration and exit
                    // instead of continuing to send alerts for a disabled monitor.
                    check(preferences.edit().clear().commit()) {
                        "无法清除天气监测设置"
                    }
                    WeatherBackgroundScheduler.cancel(activity)
                    cancelWeatherNotification(activity)
                }
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject(error.message ?: "无法关闭天气后台监测")
            }
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "途迹天气预警", NotificationManager.IMPORTANCE_DEFAULT),
        )
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

    private fun restorePreferencesLocked(
        preferences: android.content.SharedPreferences,
        destination: String?,
        dates: String?,
        lastAlert: String?,
        generation: String?,
    ) {
        val editor = preferences.edit()
        if (destination == null) editor.remove("destination") else editor.putString("destination", destination)
        if (dates == null) editor.remove("dates") else editor.putString("dates", dates)
        if (lastAlert == null) editor.remove("lastAlert") else editor.putString("lastAlert", lastAlert)
        if (generation == null) editor.remove("generation") else editor.putString("generation", generation)
        check(editor.commit()) { "无法恢复天气监测设置" }
    }

    private companion object {
        const val PREFS = "route_weather_background"
        const val CHANNEL_ID = "route-weather-alerts"
        const val NOTIFICATION_REQUEST = 7815

    }
}

class WeatherRiskWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private data class Configuration(val destination: String, val generation: String, val dates: List<String>)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // WorkManager normally waits for user unlock, but a restored or vendor
        // customized scheduler may still invoke a worker during direct boot.
        // Credential-protected preferences can look empty at that point; never
        // clear them or cancel work based on that temporary view. The unlock
        // receiver will re-register the monitor with the real configuration.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val userManager = applicationContext.getSystemService(UserManager::class.java)
            if (userManager != null && !userManager.isUserUnlocked) {
                return@withContext Result.success()
            }
        }
        val prefs = applicationContext.getSharedPreferences("route_weather_background", Context.MODE_PRIVATE)
        try {
            // Read every field and clean up invalid/expired work atomically
            // with schedule/cancel. Otherwise a worker could read an empty old
            // destination, then clear a newly saved trip and cancel its work.
            // Submit cancellation under the same lock, without waiting for the
            // current worker to terminate; a new schedule is enqueued afterwards.
            val configuration = synchronized(WeatherBackgroundLock) {
                val destination = prefs.getString("destination", null)
                val generation = prefs.getString("generation", null)
                val rawDates = runCatching {
                    val array = JSONArray(prefs.getString("dates", "[]"))
                    (0 until array.length()).map { array.optString(it) }
                }.getOrDefault(emptyList())
                val dates = rawDates.filter(WeatherMonitorPolicy::isCalendarDate).distinct().take(MAX_MONITOR_DATES)
                if (destination.isNullOrBlank() || destination.length > 120 || generation.isNullOrBlank() ||
                    dates.isEmpty() || rawDates.size != dates.size ||
                    WeatherMonitorPolicy.isExpired(dates, System.currentTimeMillis())) {
                    if (!prefs.edit().clear().commit()) throw IOException("无法清除失效的天气监测设置")
                    // Cancel only this concrete worker. Cancelling by unique
                    // name is asynchronous and can race a new trip that
                    // re-registers the same name immediately after the lock.
                    cancelCurrentWork()
                    null
                } else {
                    Configuration(destination, generation, dates)
                }
            } ?: return@withContext Result.success()
            val (destination, generation, dates) = configuration
            val coordinates = geocode(destination) ?: return@withContext Result.success()
            val forecast = forecast(coordinates.first, coordinates.second)
            val daily = forecast.optJSONObject("daily") ?: return@withContext Result.success()
            val times = daily.optJSONArray("time") ?: return@withContext Result.success()
            val codes = daily.optJSONArray("weather_code") ?: return@withContext Result.success()
            val rain = daily.optJSONArray("precipitation_probability_max")
            val riskyDates = dates.mapNotNull { date ->
                val index = (0 until times.length()).firstOrNull { times.optString(it) == date } ?: return@mapNotNull null
                val code = codes.optInt(index, 0)
                val chance = rain?.optInt(index, 0) ?: 0
                if (code >= 95 || chance >= 70) Triple(date, code, chance) else null
            }
            if (!isCurrentConfiguration(prefs, generation, destination, dates)) return@withContext Result.success()
            if (riskyDates.isNotEmpty()) {
                notifyRisk(destination, riskyDates, generation)
            } else {
                synchronized(WeatherBackgroundLock) {
                    if (isCurrentConfiguration(prefs, generation, destination, dates)) {
                        if (!prefs.edit().remove("lastAlert").commit()) {
                            throw IOException("无法清除天气提醒状态")
                        }
                        cancelWeatherNotification(applicationContext)
                    }
                }
            }
            Result.success()
        } catch (error: CancellationException) {
            // REPLACE/disable cancels an in-flight coroutine. Never turn
            // cancellation into a retry for the old trip.
            throw error
        } catch (_: PermanentWeatherException) {
            // 无结果、参数或协议错误不会因重试改变，避免后台任务永久耗电。
            Result.success()
        } catch (_: JSONException) {
            Result.success()
        } catch (_: SecurityException) {
            // Notification permission can be revoked between the preflight check
            // and notify(). The next foreground schedule will retry after the user
            // grants access again; a background retry would just spin.
            Result.success()
        } catch (_: IOException) {
            Result.retry()
        } catch (_: Exception) {
            // Keep unexpected platform/storage failures observable to WorkManager
            // instead of marking the check complete and silently losing it.
            Result.retry()
        }
    }

    private fun cancelCurrentWork() {
        WorkManager.getInstance(applicationContext).cancelWorkById(id)
    }

    private fun geocode(destination: String): Pair<Double, Double>? {
        val url = URL("https://geocoding-api.open-meteo.com/v1/search?name=${java.net.URLEncoder.encode(destination, "UTF-8")}&count=1&language=zh&format=json")
        val json = readJson(url)
        val result = json.optJSONArray("results")?.optJSONObject(0) ?: return null
        return result.optDouble("latitude").takeIf { !it.isNaN() }?.let { latitude ->
            result.optDouble("longitude").takeIf { !it.isNaN() }?.let { longitude -> latitude to longitude }
        }
    }

    private fun forecast(latitude: Double, longitude: Double): JSONObject {
        val url = URL("https://api.open-meteo.com/v1/forecast?latitude=$latitude&longitude=$longitude&daily=weather_code,precipitation_probability_max&forecast_days=16&timezone=auto")
        return readJson(url)
    }

    private fun readJson(url: URL): JSONObject {
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("User-Agent", "RoutePlanner-WeatherWorker")
        return try {
            val responseCode = connection.responseCode
            if (WeatherMonitorPolicy.isPermanentHttpFailure(responseCode)) throw PermanentWeatherException("weather HTTP $responseCode")
            if (responseCode !in 200..299) throw IOException("weather HTTP $responseCode")
            if (connection.contentLengthLong > MAX_RESPONSE_BYTES) {
                throw PermanentWeatherException("weather response too large")
            }
            JSONObject(readLimitedText(connection.inputStream))
        } finally {
            connection.disconnect()
        }
    }

    private fun readLimitedText(input: java.io.InputStream): String {
        input.use { stream ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0L
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                total += count
                if (total > MAX_RESPONSE_BYTES) throw PermanentWeatherException("weather response too large")
                output.write(buffer, 0, count)
            }
            return output.toString(Charsets.UTF_8.name())
        }
    }

    private class PermanentWeatherException(message: String) : Exception(message)

    private fun isCurrentConfiguration(
        prefs: android.content.SharedPreferences,
        generation: String,
        destination: String,
        dates: List<String>,
    ): Boolean {
        if (prefs.getString("generation", null) != generation) return false
        if (prefs.getString("destination", null) != destination) return false
        return runCatching {
            val currentDates = JSONArray(prefs.getString("dates", "[]"))
            dates == (0 until currentDates.length()).map { currentDates.optString(it) }
        }.getOrDefault(false)
    }

    private fun notifyRisk(destination: String, risks: List<Triple<String, Int, Int>>, generation: String) {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            applicationContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        if (!NotificationManagerCompat.from(applicationContext).areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = manager.getNotificationChannel("route-weather-alerts")
            if (channel == null) {
                manager.createNotificationChannel(
                    NotificationChannel("route-weather-alerts", "途迹天气预警", NotificationManager.IMPORTANCE_DEFAULT),
                )
            } else if (channel.importance == NotificationManager.IMPORTANCE_NONE) {
                return
            }
        }
        // Include the destination so switching trips cannot suppress a new city's alert
        // merely because its dates and weather codes happen to match the previous trip.
        val signature = "$destination|" + risks.joinToString("|") { "${it.first}:${it.second}:${it.third}" }
        val prefs = applicationContext.getSharedPreferences("route_weather_background", Context.MODE_PRIVATE)
        synchronized(WeatherBackgroundLock) {
            if (prefs.getString("generation", null) != generation) return
            if (prefs.getString("lastAlert", null) == signature) return
            val first = risks.first()
            val description = if (first.second >= 95) "有雷雨风险" else "降水概率 ${first.third}%"
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) android.app.Notification.Builder(applicationContext, "route-weather-alerts") else @Suppress("DEPRECATION") android.app.Notification.Builder(applicationContext)
            val openApp = android.content.Intent(applicationContext, MainActivity::class.java).apply {
                flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val contentIntent = android.app.PendingIntent.getActivity(
                applicationContext,
                WEATHER_NOTIFICATION_ID,
                openApp,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            manager.notify(WEATHER_NOTIFICATION_ID, builder.setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("$destination 天气提醒")
                .setContentText("${first.first} $description，请调整户外行程。")
                .setContentIntent(contentIntent)
                .setAutoCancel(true).build())
            if (!prefs.edit().putString("lastAlert", signature).commit()) {
                throw IOException("无法保存天气提醒状态")
            }
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 2L * 1024L * 1024L
    }
}
