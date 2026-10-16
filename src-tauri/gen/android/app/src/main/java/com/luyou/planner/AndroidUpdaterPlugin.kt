package com.luyou.planner

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

@TauriPlugin
class AndroidUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    private val releaseApi = "https://api.github.com/repos/${BuildConfig.UPDATE_REPOSITORY}/releases/latest"
    private val maxApkBytes = 300L * 1024L * 1024L
    private val maxReleaseBytes = 2L * 1024L * 1024L
    private val installInProgress = AtomicBoolean(false)

    // 自更新是后台静默能力，ACL 拒绝与网络失败都不会打到 logcat，
    // 出问题时完全无从判断。这里统一走 RouteUpdater 标签，便于 adb logcat 观测。
    // 排查命令：adb logcat -s RouteUpdater:V
    private companion object {
        const val TAG = "RouteUpdater"
    }

    @InvokeArg
    class InstallArgs {
        lateinit var version: String
        lateinit var url: String
    }

    @Command
    fun check(invoke: Invoke) {
        // 这行日志同时也是「ACL 权限已生效」的判据：
        // 若 android-updater 未在 build.rs / capabilities 里登记，
        // 命令会被 ACL 直接拒绝，这里根本不会执行、也不会有任何日志。
        Log.i(TAG, "收到自更新检查请求，当前版本 ${currentVersionName()}")
        runInBackground(invoke) {
            val release = fetchLatestRelease()
            if (release == null) {
                Log.i(TAG, "已是最新版本，无需更新")
                invoke.resolve()
            } else {
                Log.i(TAG, "发现新版本 ${release["version"]}（${release["name"]}）")
                invoke.resolveObject(release)
            }
        }
    }

    @Command
    fun install(invoke: Invoke) {
        runInBackground(invoke) {
            if (!installInProgress.compareAndSet(false, true)) {
                throw IllegalStateException("已有更新任务正在进行")
            }
            try {
                val release = invoke.parseArgs(InstallArgs::class.java)
                val url = release.url
                val version = release.version
                Log.i(TAG, "开始安装更新 $version")
                if (!UpdatePolicy.isAllowedAssetUrl(url, BuildConfig.UPDATE_REPOSITORY)) throw IllegalArgumentException("更新地址无效")
                UpdatePolicy.validateVersion(version)

                val apk = downloadApk(url, version)
                try {
                    validateApk(apk, version)
                } catch (error: Exception) {
                    apk.delete()
                    throw error
                }
                Log.i(TAG, "更新包校验通过：${apk.name}（${apk.length()} 字节）")
                activity.runOnUiThread {
                    var installerOpened = false
                    try {
                        openInstaller(apk)
                        installerOpened = true
                        invoke.resolve()
                    } catch (error: Exception) {
                        // The installer owns the file only after startActivity
                        // succeeds. If settings/intent resolution fails, remove
                        // the validated APK immediately instead of leaving a
                        // private-cache artifact until the next update attempt.
                        runCatching { if (!installerOpened) apk.delete() }
                        invoke.reject(error.message ?: "无法打开安装器")
                    } finally {
                        // Keep the native guard held until the installer launch has
                        // actually been attempted. This closes the small race where
                        // a second tap could start another download while the first
                        // install intent was still queued on the UI thread.
                        installInProgress.set(false)
                    }
                }
            } catch (error: Exception) {
                // UI-thread failures are handled in the callback above; failures
                // before posting the callback must release the guard here.
                installInProgress.set(false)
                throw error
            }
        }
    }

    private fun runInBackground(invoke: Invoke, work: () -> Unit) {
        thread(name = "route-planner-updater") {
            try {
                work()
            } catch (error: Exception) {
                Log.w(TAG, "更新流程失败：${error.message}", error)
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
            val code = connection.responseCode
            UpdatePolicy.requireReleaseSuccess(code)
            val body = readLimitedText(connection.inputStream, maxReleaseBytes)
            val release = JSONObject(body)
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) {
                Log.i(TAG, "最新 Release 是草稿或预发布，跳过")
                return null
            }

            val currentVersion = currentVersionName()
            val tagVersion = UpdatePolicy.normalizeVersion(release.optString("tag_name"))
            Log.i(TAG, "远端最新 tag=$tagVersion，本机=$currentVersion")
            UpdatePolicy.validateVersion(tagVersion)
            if (compareVersions(tagVersion, currentVersion) <= 0) return null

            val assets = release.optJSONArray("assets") ?: throw IllegalStateException("新版尚未提供 Android 安装包，请稍后重试")
            var selected: Map<String, String>? = null
            var selectedRank = Int.MAX_VALUE
            for (index in 0 until assets.length()) {
                val asset = assets.optJSONObject(index) ?: continue
                val name = asset.optString("name")
                val url = asset.optString("browser_download_url")
                val rank = UpdatePolicy.assetRank(name, Build.SUPPORTED_ABIS.toList()) ?: continue
                if (rank < selectedRank && UpdatePolicy.isAllowedAssetUrl(url, BuildConfig.UPDATE_REPOSITORY)) {
                    selected = mapOf("version" to tagVersion, "url" to url, "name" to name)
                    selectedRank = rank
                }
            }
            return selected ?: throw IllegalStateException("新版尚无适合此设备的 Android 安装包，请稍后重试")
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadApk(url: String, version: String): File {
        val connection = openAssetConnection(url)
        // Versions before the dedicated updates directory stored APKs beside
        // user exports. Remove only the updater naming pattern during the next
        // update attempt; ordinary exported files must remain untouched.
        cleanupLegacyExportDownloads()
        // Keep updater artifacts separate from user exports. A large APK or a
        // cleanup pass must never contend with a file currently held by the
        // system share chooser.
        val updateDir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val target = File(updateDir, "route-planner-$version.apk")
        val temporary = File(updateDir, "$version.apk.download")
        try {
            cleanupOldDownloads(updateDir, target, temporary)
            if (connection.responseCode !in 200..299) throw IllegalStateException("下载更新失败：HTTP ${connection.responseCode}")
            if (!UpdatePolicy.isAllowedDownloadUrl(connection.url.toString(), BuildConfig.UPDATE_REPOSITORY)) {
                throw IllegalStateException("更新下载被重定向到不受信任的地址")
            }
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
                    UpdatePolicy.validateDownload(total, expectedLength)
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

    private fun openAssetConnection(value: String): HttpURLConnection {
        var url = URL(value)
        for (hop in 0..5) {
            check(UpdatePolicy.isAllowedDownloadUrl(url.toString(), BuildConfig.UPDATE_REPOSITORY)) {
                "更新下载被重定向到不受信任的地址"
            }
            val connection = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 120_000
                requestMethod = "GET"
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "RoutePlanner-Android-Updater")
            }
            try {
                if (!UpdatePolicy.isRedirect(connection.responseCode)) return connection
                check(hop < 5) { "更新下载重定向次数过多" }
                val location = connection.getHeaderField("Location")
                check(!location.isNullOrBlank()) { "更新下载重定向地址缺失" }
                url = URL(url, location)
            } catch (error: Exception) {
                connection.disconnect()
                throw error
            }
            connection.disconnect()
        }
        error("更新下载重定向次数过多")
    }

    private fun cleanupOldDownloads(directory: File, current: File, temporary: File) {
        directory.listFiles()?.forEach { file ->
            if (file == current || file == temporary) return@forEach
            if ((file.name.startsWith("route-planner-") && file.name.endsWith(".apk", ignoreCase = true)) ||
                file.name.endsWith(".apk.download", ignoreCase = true)) {
                runCatching { file.delete() }
            }
        }
    }

    private fun cleanupLegacyExportDownloads() {
        val legacyDir = File(activity.cacheDir, "exports")
        legacyDir.listFiles()?.forEach { file ->
            if ((file.name.startsWith("route-planner-") && file.name.endsWith(".apk", ignoreCase = true)) ||
                file.name.endsWith(".apk.download", ignoreCase = true)) {
                runCatching { file.delete() }
            }
        }
    }

    private fun readLimitedText(input: java.io.InputStream, maxBytes: Long): String {
        input.use { stream ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0L
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                total += count
                if (total > maxBytes) throw IllegalStateException("更新信息响应过大")
                output.write(buffer, 0, count)
            }
            return output.toString(Charsets.UTF_8.name())
        }
    }

    private fun validateApk(apk: File, expectedVersion: String) {
        UpdatePolicy.validateVersion(expectedVersion)
        val packageManager = activity.packageManager
        val signatureFlags = UpdatePolicy.signatureFlags(Build.VERSION.SDK_INT)
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageArchiveInfo(
                apk.absolutePath,
                PackageManager.PackageInfoFlags.of(signatureFlags.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageArchiveInfo(apk.absolutePath, signatureFlags)
        }
            ?: throw IllegalStateException("更新包无法识别")
        if (info.packageName != activity.packageName) throw IllegalStateException("更新包不是途迹应用")
        val packageVersion = UpdatePolicy.normalizeVersion(info.versionName ?: "")
        if (packageVersion != expectedVersion) {
            throw IllegalStateException("更新包版本与 Release 不一致")
        }
        val newVersion = versionCode(info)
        val currentInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageInfo(
                activity.packageName,
                PackageManager.PackageInfoFlags.of(signatureFlags.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(activity.packageName, signatureFlags)
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
        return UpdatePolicy.normalizeVersion(info.versionName ?: "0.0.0")
    }

    private fun compareVersions(left: String, right: String): Int {
        val a = left.split(".").map { it.toIntOrNull() ?: 0 }
        val b = right.split(".").map { it.toIntOrNull() ?: 0 }
        for (index in 0 until maxOf(a.size, b.size)) {
            val result = (a.getOrElse(index) { 0 }).compareTo(b.getOrElse(index) { 0 })
            if (result != 0) return result
        }
        return 0
    }

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
