package com.luyou.planner

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log

/** Recoverable notification permission flow shared by reminders and weather alerts. */
internal object NotificationPermissionHelper {
    private const val PREFS = "route_notification_permission"
    private const val REQUESTED = "post_notifications_requested"
    // Reminder and weather registration use separate JS queues. They can both
    // reach this helper while Android is still showing the first permission
    // dialog; opening channel settings from the second call would interrupt
    // that dialog and leave the user with neither flow completed.
    private val permissionGate = NotificationPermissionGate()

    fun requestOrOpenSettings(activity: Activity, channelId: String, requestCode: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            val preferences = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
            val requested = preferences.getBoolean(REQUESTED, false)
            when (permissionGate.begin(requested)) {
                NotificationPermissionGate.Action.REQUEST -> {
                    try {
                    check(preferences.edit().putBoolean(REQUESTED, true).commit()) {
                        "无法保存通知权限状态"
                    }
                    } catch (error: Exception) {
                        permissionGate.finish()
                        throw error
                    }
                    activity.runOnUiThread {
                        try {
                            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), requestCode)
                        } catch (error: Exception) {
                            preferences.edit().remove(REQUESTED).apply()
                            permissionGate.finish()
                            Log.w("RouteNotifications", "Unable to request notification permission", error)
                        }
                    }
                }
                NotificationPermissionGate.Action.SETTINGS -> openChannelSettings(activity, channelId)
                NotificationPermissionGate.Action.WAIT -> Unit
            }
            return
        }
        openChannelSettings(activity, channelId)
    }

    private fun openChannelSettings(activity: Activity, channelId: String) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
            }
        } else {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            }
        }
        activity.runOnUiThread {
            runCatching { activity.startActivity(intent) }
                .onFailure { Log.w("RouteNotifications", "Unable to open notification settings", it) }
        }
    }

    fun onRequestPermissionsResult(requestCode: Int) {
        if (requestCode == 7813 || requestCode == 7815) {
            permissionGate.finish()
        }
    }
}
