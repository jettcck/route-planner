package com.luyou.planner

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

/** Uses Android's system chooser so exported files are usable from WebView. */
@TauriPlugin
class FileSharePlugin(private val activity: Activity) : Plugin(activity) {
    @InvokeArg
    class ShareArgs {
        lateinit var filename: String
        lateinit var text: String
        lateinit var type: String
    }

    @Command
    fun shareText(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            require(args.filename.isNotBlank() && args.text.isNotEmpty()) { "export data is empty" }
            require(args.filename.length <= 240) { "filename is too long" }
            require(args.text.length <= MAX_TEXT_CHARS) { "export is too large" }
            val content = args.text.toByteArray(Charsets.UTF_8)
            require(content.size <= 10 * 1024 * 1024) { "export is too large" }
            val mimeType = args.type.trim().ifBlank { "text/plain" }
            require(mimeType.length <= 120 && MIME_TYPE.matches(mimeType)) { "export type is invalid" }
            val safeName = args.filename.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
            val directory = File(activity.cacheDir, "exports")
            check(directory.isDirectory || directory.mkdirs()) { "无法创建分享缓存目录" }
            ShareCachePolicy.reserve(directory, content.size.toLong())
            val file = createUniqueFile(directory, safeName.ifBlank { "route-export.txt" })
            try {
                file.writeBytes(content)
            } catch (error: Exception) {
                // Do not leave a truncated file that can later be selected by
                // cleanup or accidentally shared from the system chooser.
                runCatching { file.delete() }
                throw error
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, "途迹导出文件")
                clipData = ClipData.newRawUri(args.filename, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(Intent.createChooser(intent, "分享或保存文件"))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法分享文件")
        }
    }

    private fun createUniqueFile(directory: File, requestedName: String): File {
        val dot = requestedName.lastIndexOf('.')
        val stem = if (dot > 0) requestedName.substring(0, dot) else requestedName
        val extension = if (dot > 0) requestedName.substring(dot) else ""
        repeat(5) {
            val candidate = File(directory, "$stem-${UUID.randomUUID().toString().take(8)}$extension")
            if (candidate.createNewFile()) return candidate
        }
        throw IllegalStateException("无法创建分享文件")
    }

    private companion object {
        const val MAX_TEXT_CHARS = 5_000_000
        val MIME_TYPE = Regex("""[A-Za-z0-9!#\$&^_.+\-]+/[A-Za-z0-9!#\$&^_.+\-]+(?:;\s*[A-Za-z0-9._-]+=[A-Za-z0-9._-]+)*""")
    }
}
