package com.luyou.planner

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * 地图应用探测与深链启动。
 *
 * 与 AndroidUpdaterPlugin 相同的 Tauri 移动插件形态：
 * 前端通过 `plugin:map-launcher|open_map` / `plugin:map-launcher|map_apps` 调用。
 *
 * 注意：Android 11(API 30) 起存在软件包可见性限制，必须在 AndroidManifest.xml 中
 * 用 <queries> 声明目标包名，否则 getPackageInfo 会抛 NameNotFoundException，
 * 导致已安装的地图应用被误判为未安装。
 */
@TauriPlugin
class MapLauncherPlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class OpenArgs {
        lateinit var url: String
        lateinit var packageName: String
    }

    /** 返回本机已安装的支持地图应用包名列表，用于界面上的检测状态提示。 */
    @Command
    fun mapApps(invoke: Invoke) {
        val installed = SUPPORTED_PACKAGES.filter { isInstalled(it) }
        invoke.resolveObject(mapOf("packages" to installed))
    }

    /**
     * 先探测目标地图应用是否已安装；已安装则用显式 Intent 直接拉起，浏览器不参与。
     * 未安装或启动失败时返回 launched=false，由前端回落到网页地址。
     */
    @Command
    fun openMap(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        if (args.url.isBlank() || args.packageName.isBlank()) {
            invoke.resolveObject(notLaunched("invalid_args"))
            return
        }
        if (args.url.length > 2048 || args.packageName !in SUPPORTED_PACKAGES) {
            invoke.resolveObject(notLaunched("invalid_args"))
            return
        }
        val uri = runCatching { Uri.parse(args.url) }.getOrNull()
        if (uri == null || uri.scheme != ALLOWED_SCHEMES[args.packageName]) {
            invoke.resolveObject(notLaunched("invalid_scheme"))
            return
        }
        if (!isInstalled(args.packageName)) {
            invoke.resolveObject(notLaunched("not_installed"))
            return
        }
        try {
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                setPackage(args.packageName)
            }
            activity.startActivity(intent)
            invoke.resolveObject(mapOf("launched" to true))
        } catch (error: ActivityNotFoundException) {
            invoke.resolveObject(notLaunched("no_handler"))
        } catch (error: SecurityException) {
            invoke.resolveObject(notLaunched("denied"))
        } catch (error: Exception) {
            invoke.resolveObject(notLaunched("unknown"))
        }
    }

    private fun notLaunched(reason: String): Map<String, Any> =
        mapOf("launched" to false, "reason" to reason)

    private fun isInstalled(packageName: String): Boolean =
        try {
            activity.packageManager.getPackageInfo(packageName, 0)
            true
        } catch (error: PackageManager.NameNotFoundException) {
            false
        }

    private companion object {
        val SUPPORTED_PACKAGES = listOf(
            "com.autonavi.minimap", // 高德地图
            "com.baidu.BaiduMap",   // 百度地图
            "com.tencent.map",      // 腾讯地图
        )
        val ALLOWED_SCHEMES = mapOf(
            "com.autonavi.minimap" to "androidamap",
            "com.baidu.BaiduMap" to "baidumap",
            "com.tencent.map" to "qqmap",
        )
    }
}
