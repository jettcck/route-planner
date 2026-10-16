// ---------------------------------------------------------------------------
// so-fix.gradle.kts
//
// 背景：在 Windows 未启用「开发者模式」时，普通进程不具备
// SeCreateSymbolicLinkPrivilege。Tauri CLI 在把 Rust 产物链接到 jniLibs 时
// 使用 symlink_file，创建 reparse point 失败后**既不报错也不回退为拷贝**，
// 最终在 jniLibs 目录留下一个 0 字节占位文件。
//
// 后果：AGP 打包出的 APK 内 lib/arm64-v8a/libroute_planner_lib.so 为空，
//       安装后应用启动即崩溃（原生库缺失）。
//
// 本脚本在打包流程中回填真实产物，使构建不依赖开发者模式。
// 挂载点（双重保险）：
//   1. rustBuild*          —— doLast   ：Tauri CLI 刚写完，立即回填；
//   2. merge*JniLibFolders —— doFirst  ：AGP 读取 jniLibs 之前兜底。
//
// 若将来启用了开发者模式（HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\
// AppModelUnlock\AllowDevelopmentWithoutDevLicense = 1），此脚本变为无害的
// 空操作，可安全保留。
// ---------------------------------------------------------------------------

val configuredTargetDir = System.getenv("CARGO_TARGET_DIR")?.takeIf { it.isNotBlank() }
val rustTargetDir = configuredTargetDir?.let { File(it) }
    // rootProject is src-tauri/gen/android; Cargo's default target directory
    // is two levels above that generated Android project.
    ?: rootProject.layout.projectDirectory.dir("../../target").asFile
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs").asFile

val abiByTriple = linkedMapOf(
    "aarch64-linux-android" to "arm64-v8a",
    "armv7-linux-androideabi" to "armeabi-v7a",
    "i686-linux-android" to "x86",
    "x86_64-linux-android" to "x86_64",
)
// The local Windows release wrapper can intentionally build one ABI for a
// fast iteration. Do not reintroduce stale libraries from previous builds
// while Gradle runs its fallback copy hooks. A normal Tauri build leaves this
// variable unset and restores every supported ABI.
val requestedTargets = System.getenv("ANDROID_TARGETS")
    ?.split(Regex("[ ,]+"))
    ?.map(String::trim)
    ?.filter(String::isNotEmpty)
    .orEmpty()
val requestedAbis = requestedTargets.mapNotNull { target ->
    when (target) {
        "aarch64", "arm64-v8a" -> "arm64-v8a"
        "armv7", "armeabi-v7a" -> "armeabi-v7a"
        "i686", "x86" -> "x86"
        "x86_64" -> "x86_64"
        else -> null
    }
}.toSet()
val restrictRestore = requestedTargets.isNotEmpty() && requestedAbis.isNotEmpty()

fun restoreNativeLibs() {
    abiByTriple.forEach { (triple, abi) ->
        if (restrictRestore && abi !in requestedAbis) return@forEach
        val source = File(File(rustTargetDir, triple), "release/libroute_planner_lib.so")
        if (!source.isFile || source.length() == 0L) return@forEach

        val dest = File(File(jniLibsDir, abi), "libroute_planner_lib.so")
        if (dest.isFile && dest.length() == source.length()) return@forEach

        dest.parentFile?.mkdirs()
        dest.delete()
        source.copyTo(dest, overwrite = true)
        logger.lifecycle("[so-fix] 回填 $abi : ${source.length()} bytes -> ${dest.path}")
    }
}

tasks.matching { it.name.startsWith("rustBuild") }.configureEach {
    doLast { restoreNativeLibs() }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach {
    doFirst { restoreNativeLibs() }
}
