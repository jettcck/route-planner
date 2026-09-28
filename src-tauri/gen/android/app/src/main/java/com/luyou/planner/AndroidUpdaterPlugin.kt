package com.luyou.planner

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.annotation.InvokeArg
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import kotlin.concurrent.thread

@TauriPlugin
class AndroidUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    private val releaseApi = "https://api.github.com/repos/jettcck/route-planner/releases/latest"
    private val releaseAssetPrefix = "https://github.com/jettcck/route-planner/releases/download/"
    private val maxApkBytes = 300L * 1024L * 1024L

    @InvokeArg
    class InstallArgs {
        lateinit var version: String
        lateinit var url: String
    }

    @Command
    fun check(invoke: Invoke) {
        runInBackground(invoke) {
            val release = fetchLatestRelease()
            if (release == null) invoke.resolve()
            else invoke.resolveObject(release)
        }
    }

    @Command
    fun install(invoke: Invoke) {
        runInBackground(invoke) {
            val release = invoke.parseArgs(InstallArgs::class.java)
            val url = release.url
            val version = release.version
            if (!isAllowedAssetUrl(url)) throw IllegalArgumentException("更新地址无效")
            if (version.isBlank()) throw IllegalArgumentException("更新版本无效")

            val apk = downloadApk(url, version)
            validateApk(apk)
            activity.runOnUiThread {
                try {
                    openInstaller(apk)
                    invoke.resolve()
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "无法打开安装器")
                }
            }
        }
    }

    private fun runInBackground(invoke: Invoke, work: () -> Unit) {
        thread(name = "route-planner-updater") {
            try {
                work()
            } catch (error: Exception) {
                invoke.reject(error.message ?: "更新检查失败")
            }
        }
    }

    private fun fetchLatestRelease(): Map<String, String>? {
        val connection = (URL(releaseApi).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "RoutePlanner-Android-Updater")
        }
        try {
            if (connection.responseCode !in 200..299) return null
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val release = JSONObject(body)
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null

            val currentVersion = currentVersionName()
            val tagVersion = normalizeVersion(release.optString("tag_name"))
            if (tagVersion.isBlank() || compareVersions(tagVersion, currentVersion) <= 0) return null

            val assets = release.optJSONArray("assets") ?: return null
            for (index in 0 until assets.length()) {
                val asset = assets.optJSONObject(index) ?: continue
                val name = asset.optString("name")
                val url = asset.optString("browser_download_url")
                if (name.contains("arm64", ignoreCase = true) && name.endsWith(".apk", ignoreCase = true) && isAllowedAssetUrl(url)) {
                    return mapOf("version" to tagVersion, "url" to url, "name" to name)
                }
            }
            return null
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadApk(url: String, version: String): File {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 120_000
            requestMethod = "GET"
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "RoutePlanner-Android-Updater")
        }
        val target = File(activity.cacheDir, "route-planner-$version.apk")
        val temporary = File(activity.cacheDir, "$version.apk.download")
        try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("下载更新失败：HTTP ${connection.responseCode}")
            val expectedLength = connection.contentLengthLong
            if (expectedLength > maxApkBytes) throw IllegalStateException("更新包超过 300 MB")
            connection.inputStream.use { input ->
                FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > maxApkBytes) throw IllegalStateException("更新包超过 300 MB")
                        output.write(buffer, 0, count)
                    }
                }
            }
            if (!temporary.renameTo(target)) {
                temporary.copyTo(target, overwrite = true)
                temporary.delete()
            }
            return target
        } finally {
            connection.disconnect()
            temporary.delete()
        }
    }

    private fun validateApk(apk: File) {
        val packageManager = activity.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageArchiveInfo(
                apk.absolutePath,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
        }
            ?: throw IllegalStateException("更新包无法识别")
        if (info.packageName != activity.packageName) throw IllegalStateException("更新包不是途迹应用")
        val newVersion = versionCode(info)
        val currentInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageInfo(
                activity.packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }
        if (newVersion <= versionCode(currentInfo)) throw IllegalStateException("更新版本不是最新")

        val archiveSignatures = signatures(info)
        val installedSignatures = signatures(currentInfo)
        if (archiveSignatures.isEmpty() || archiveSignatures != installedSignatures) {
            throw IllegalStateException("更新包签名不匹配")
        }
    }

    private fun openInstaller(apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            val settings = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${activity.packageName}")
            )
            activity.startActivity(settings)
            throw IllegalStateException("请允许途迹安装未知应用后重试")
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }

    private fun currentVersionName(): String {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        return normalizeVersion(info.versionName ?: "0.0.0")
    }

    private fun normalizeVersion(value: String): String = value.trim().removePrefix("v").split("-")[0]

    private fun compareVersions(left: String, right: String): Int {
        val a = left.split(".").map { it.toIntOrNull() ?: 0 }
        val b = right.split(".").map { it.toIntOrNull() ?: 0 }
        for (index in 0 until maxOf(a.size, b.size)) {
            val result = (a.getOrElse(index) { 0 }).compareTo(b.getOrElse(index) { 0 })
            if (result != 0) return result
        }
        return 0
    }

    private fun isAllowedAssetUrl(value: String): Boolean =
        value.startsWith(releaseAssetPrefix) && value.endsWith(".apk", ignoreCase = true)

    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()

    private fun signatures(info: PackageInfo): Set<String> {
        val signingInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners?.toList().orEmpty()
        } else {
            @Suppress("DEPRECATION")
            info.signatures?.toList().orEmpty()
        }
        return signingInfo.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                .joinToString("") { byte -> "%02x".format(Locale.ROOT, byte) }
        }.toSet()
    }
}
