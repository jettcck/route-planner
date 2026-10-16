package com.luyou.planner

import java.io.File

/** Reserve space before an export without breaking a recently granted share URI. */
internal object ShareCachePolicy {
    const val MAX_SHARE_FILES = 20
    const val MAX_SHARE_BYTES = 50L * 1024 * 1024
    const val RECENT_SHARE_MILLIS = 60L * 60 * 1000
    private const val MAX_AGE_MILLIS = 7L * 24 * 60 * 60 * 1000

    @JvmOverloads
    fun reserve(
        directory: File,
        incomingBytes: Long,
        now: Long = System.currentTimeMillis(),
        deleteFile: (File) -> Boolean = { it.delete() },
    ) {
        require(incomingBytes in 1..MAX_SHARE_BYTES) { "export is too large" }
        val files = directory.listFiles()?.filter {
            it.isFile && !it.name.endsWith(".apk", ignoreCase = true) &&
                !it.name.endsWith(".apk.download", ignoreCase = true)
        }?.sortedBy { it.lastModified() }?.toMutableList()
            ?: throw IllegalStateException("无法读取分享缓存目录")
        var total = files.sumOf { it.length() }
        for (file in files.toList()) {
            val modified = file.lastModified()
            // Future timestamps are protected too (e.g. after a clock change).
            if (modified > now || now - modified < RECENT_SHARE_MILLIS) continue
            val expired = now - modified > MAX_AGE_MILLIS
            val needsSpace = files.size + 1 > MAX_SHARE_FILES || total + incomingBytes > MAX_SHARE_BYTES
            if (!expired && !needsSpace) continue
            val bytes = file.length()
            if (runCatching { deleteFile(file) }.getOrDefault(false)) {
                files.remove(file)
                total -= bytes
            }
        }
        check(files.size + 1 <= MAX_SHARE_FILES && total + incomingBytes <= MAX_SHARE_BYTES) {
            "分享缓存暂时已满，请稍后再试"
        }
    }
}
