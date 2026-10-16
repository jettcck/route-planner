package com.luyou.planner

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Makes the WebView geolocation permission explicit on Android.
 *
 * Android WebView can reject navigator.geolocation before it has an app-level
 * runtime grant. The frontend still owns the actual location lookup; this
 * plugin only checks and requests the two coarse/fine permissions required by
 * the platform.
 */
@TauriPlugin(
    permissions = [
        Permission(
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ],
            alias = "location",
        ),
    ],
)
class LocationPermissionPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun request(invoke: Invoke) {
        try {
            val fine = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val coarse = activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (fine || coarse) {
                invoke.resolveObject(mapOf("granted" to true, "requested" to false))
                return
            }
            requestPermissionForAlias("location", invoke, "permissionCallback")
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法请求定位权限")
        }
    }

    @PermissionCallback
    fun permissionCallback(invoke: Invoke) {
        val fine = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        invoke.resolveObject(mapOf("granted" to (fine || coarse), "requested" to true))
    }

    @Command
    fun status(invoke: Invoke) {
        val fine = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        invoke.resolveObject(mapOf("granted" to (fine || coarse)))
    }

}
