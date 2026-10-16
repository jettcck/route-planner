package com.luyou.planner

import android.content.pm.PackageManager
import java.net.URL
import java.util.Locale

/** Pure rules shared by the network updater and its local regression tests. */
internal object UpdatePolicy {
    private const val DEFAULT_REPOSITORY = "jettcck/route-planner"
    private val repositoryPattern = Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")

    private fun releaseRepositoryPath(repository: String): String {
        require(repositoryPattern.matches(repository)) { "更新仓库格式无效" }
        return "/$repository/releases/download/"
    }

    fun validateVersion(version: String) {
        require(version.matches(Regex("\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}"))) { "更新版本格式无效" }
    }

    /** Remove only the optional tag prefix; never discard prerelease suffixes. */
    fun normalizeVersion(value: String): String = value.trim().removePrefix("v")

    fun requireReleaseSuccess(code: Int) {
        if (code == 403 || code == 429) error("更新服务暂时限流，请稍后重试（HTTP $code）")
        if (code !in 200..299) error("无法检查更新：HTTP $code")
    }

    @Suppress("DEPRECATION")
    fun signatureFlags(sdk: Int): Int =
        if (sdk >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    fun validateDownload(actual: Long, expected: Long) {
        check(actual > 0) { "下载的更新包为空，请重试" }
        check(expected < 0 || actual == expected) { "更新包下载不完整，请重试" }
    }

    /** Initial assets must be GitHub release APKs from this repository. */
    fun isAllowedAssetUrl(value: String, repository: String = DEFAULT_REPOSITORY): Boolean = runCatching {
        val repositoryPath = releaseRepositoryPath(repository)
        val url = URL(value)
        url.protocol.equals("https", ignoreCase = true) &&
            (url.port == -1 || url.port == 443) && url.userInfo == null &&
            url.host.equals("github.com", ignoreCase = true) &&
            url.path.startsWith(repositoryPath) &&
            url.path.endsWith(".apk", ignoreCase = true)
    }.getOrDefault(false)

    /** GitHub redirects release downloads to one of these signed asset hosts. */
    fun isAllowedDownloadUrl(value: String, repository: String = DEFAULT_REPOSITORY): Boolean = runCatching {
        val repositoryPath = releaseRepositoryPath(repository)
        val url = URL(value)
        // GitHub's signed asset URLs use opaque IDs with no .apk extension.
        // Only the original repository release URL must name an APK. Package
        // identity, version and signing certificates validate the payload.
        if (!url.protocol.equals("https", ignoreCase = true) ||
            (url.port != -1 && url.port != 443) ||
            url.userInfo != null
        ) return@runCatching false
        when (url.host.lowercase(Locale.ROOT)) {
            "github.com" -> url.path.startsWith(repositoryPath) &&
                url.path.endsWith(".apk", ignoreCase = true)
            "release-assets.githubusercontent.com", "objects.githubusercontent.com" -> true
            else -> false
        }
    }.getOrDefault(false)

    fun isRedirect(code: Int): Boolean = code in listOf(301, 302, 303, 307, 308)

    /** Lower ranks win. Universal builds work across every supported device ABI. */
    fun assetRank(name: String, abis: List<String>): Int? {
        val lower = name.lowercase(Locale.ROOT)
        if (!lower.endsWith(".apk")) return null
        // `-android.apk` is the universal naming convention used by this
        // project, but a fork may publish `arm64-android.apk`. Do not let the
        // suffix hide an explicit ABI marker and make a device install the
        // wrong native library set.
        val hasArchitectureMarker = listOf("arm64", "aarch64", "armeabi", "armv7", "x86_64", "x86", "i686")
            .any(lower::contains)
        if ((lower.contains("universal") || lower.endsWith("-android.apk")) && !hasArchitectureMarker) return 0
        return abis.indexOfFirst { abi ->
            when (abi) {
                "arm64-v8a" -> lower.contains("arm64") || lower.contains("aarch64")
                "armeabi-v7a" -> lower.contains("armeabi-v7a") || lower.contains("armv7")
                "x86_64" -> lower.contains("x86_64")
                "x86" -> !lower.contains("x86_64") && (lower.contains("x86") || lower.contains("i686"))
                else -> false
            }
        }.takeIf { it >= 0 }?.plus(1)
    }
}
