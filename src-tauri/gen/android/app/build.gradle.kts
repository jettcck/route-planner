import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val signingProperties = Properties().apply {
    val propFile = file("key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Keep Android self-updates pointed at the repository that produced the APK.
// GitHub Actions injects the current repository for forks; local builds use the
// upstream default unless ROUTE_ANDROID_UPDATE_REPOSITORY is provided.
val updateRepository = (System.getenv("ROUTE_ANDROID_UPDATE_REPOSITORY") ?: "jettcck/route-planner").trim()
require(updateRepository.matches(Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"))) {
    "ROUTE_ANDROID_UPDATE_REPOSITORY must be in owner/repository format"
}

android {
    compileSdk = 36
    namespace = "com.luyou.planner"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.luyou.planner"
        minSdk = 24
        // 与 compileSdk 对齐：Google Play 2025 起要求新应用 target 至少 35，
        // 而对齐 36 可避免「编译用 36、运行按 35」的兼容分支差异。
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "UPDATE_REPOSITORY", "\"$updateRepository\"")
    }
    signingConfigs {
        create("release") {
            val storeFilePath = signingProperties.getProperty("storeFile")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            if (System.getenv("ROUTE_ANDROID_LOCAL_DEBUG_SIGNING") == "1") {
                // The local Windows acceptance APK is intentionally built
                // without a production HTTPS endpoint so it can exercise the
                // host service through 10.0.2.2. Keep cleartext enabled only
                // for this explicitly debug-signed artifact; CI production
                // builds leave the default false in place.
                manifestPlaceholders["usesCleartextTraffic"] = "true"
            }
            if (!signingProperties.getProperty("storeFile").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            } else if (System.getenv("ROUTE_ANDROID_LOCAL_DEBUG_SIGNING") == "1") {
                // The Windows local release wrapper must remain installable even
                // when no production keystore is available. CI always provides
                // key.properties and therefore uses the real release key.
                signingConfig = signingConfigs.getByName("debug")
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        // JDK 21 工具链下统一用 17：既是 AGP 8.x 的默认 target，
        // 也能让 Java 与 Kotlin 两侧字节码版本一致（此前 1.8 会在部分
        // 依赖上触发 "inconsistent JVM-target compatibility" 警告）。
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// 回填 Tauri CLI 因缺少符号链接权限而写空的 Rust 原生库。
// 详见 app/so-fix.gradle.kts。若重新执行 `tauri android init` 会丢失此行，需补回。
apply(from = file("so-fix.gradle.kts"))

// Windows without Developer Mode cannot create the symlink that Tauri's
// Android Rust task normally uses. The local release wrapper prebuilds and
// copies the native library, then sets this flag so Gradle only packages it.
if (System.getenv("ROUTE_ANDROID_SKIP_RUST_BUILD") == "1") {
    tasks.matching { it.name.startsWith("rustBuild") }.configureEach {
        enabled = false
    }
}
