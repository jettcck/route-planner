import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const devSupervisor = fs.readFileSync("server/dev-all.mjs", "utf8");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const tauri = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const android = fs.readFileSync("src-tauri/gen/android/app/tauri.properties", "utf8");
const androidManifest = fs.readFileSync("src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8");
const proguardRules = fs.readFileSync("src-tauri/gen/android/app/proguard-rules.pro", "utf8");
const shareBridge = fs.readFileSync("src/features/share.ts", "utf8");
const fileSharePlugin = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/FileSharePlugin.kt", "utf8");
const shareCachePolicy = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/ShareCachePolicy.kt", "utf8");
const androidTestPage = fs.readFileSync("src/android-test.tsx", "utf8");
const appSource = fs.readFileSync("src/App.tsx", "utf8");
const authSource = fs.readFileSync("src/features/auth.ts", "utf8");
const authViewSource = fs.readFileSync("src/features/auth-view.tsx", "utf8");
const secureStoreSource = fs.readFileSync("src/features/secure-store.ts", "utf8");
const checkinSource = fs.readFileSync("src/features/checkin.ts", "utf8");
const storageKeysSource = fs.readFileSync("src/features/storage-keys.ts", "utf8");
const authServerSource = fs.readFileSync("server/auth-server.mjs", "utf8");
const tauriBuild = fs.readFileSync("src-tauri/build.rs", "utf8");
const localAndroidBuild = fs.readFileSync("server/android-release-build.mjs", "utf8");
const androidGradle = fs.readFileSync("src-tauri/gen/android/app/build.gradle.kts", "utf8");
const soFix = fs.readFileSync("src-tauri/gen/android/app/so-fix.gradle.kts", "utf8");
if (!appSource.includes('const ANDROID_DIAGNOSTICS_ENABLED') ||
    !appSource.includes('lazy(() => import("./android-test"))') ||
    !appSource.includes('ANDROID_DIAGNOSTICS_ENABLED && AndroidTestPage') ||
    !appSource.includes('const ANDROID_PREVIEW_ENABLED = ANDROID_DIAGNOSTICS_ENABLED') ||
    !appSource.includes('lazy(() => import("./android-preview"))') ||
    !appSource.includes('ANDROID_PREVIEW_ENABLED && AndroidPreviewPage') ||
    !androidGradle.includes('manifestPlaceholders["usesCleartextTraffic"] = "true"') ||
    !androidGradle.includes('ROUTE_ANDROID_LOCAL_DEBUG_SIGNING') ||
    !cargo.includes('custom-protocol = ["tauri/custom-protocol"]') ||
    !localAndroidBuild.includes('"--features", "custom-protocol"') ||
    !localAndroidBuild.includes('VITE_ENABLE_ANDROID_DIAGNOSTICS: "true"') ||
    !localAndroidBuild.includes('VITE_AUTH_ENDPOINT: process.env.VITE_AUTH_ENDPOINT?.trim() || "http://10.0.2.2:8787"') ||
    !localAndroidBuild.includes('ANDROID_TARGETS: targetNames.join(" ")') ||
    !localAndroidBuild.includes('Buffer.from("/assets/index-")') ||
    !soFix.includes('dir("../../target")') ||
    !tauriBuild.includes('tauri_build::is_dev()')) {
  console.error("Android release libraries must use custom-protocol and embed frontend assets");
  process.exit(1);
}
const nativeBridge = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const notificationPlugin = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/NotificationPlugin.kt", "utf8");
const weatherPlugin = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/WeatherBackgroundPlugin.kt", "utf8");
const weatherRegistration = fs.readFileSync("src/features/weather-registration.ts", "utf8");
const weatherSource = fs.readFileSync("src/weather.ts", "utf8");
const legacyBackupRules = fs.readFileSync("src-tauri/gen/android/app/src/main/res/xml/backup_rules.xml", "utf8");
const dataExtractionRules = fs.readFileSync("src-tauri/gen/android/app/src/main/res/xml/data_extraction_rules.xml", "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const androidVersion = android.match(/^tauri\.android\.versionName=(.+)$/m)?.[1]?.trim();
const androidCode = Number(android.match(/^tauri\.android\.versionCode=(\d+)$/m)?.[1] || 0);
const versions = { package: packageJson.version, cargo: cargoVersion, tauri: tauri.version, android: androidVersion };
const mismatch = Object.entries(versions).filter(([, value]) => value !== packageJson.version);
if (mismatch.length) {
  console.error("Release version mismatch:", versions);
  process.exit(1);
}
if (!Number.isInteger(androidCode) || androidCode < 1 || androidCode > 2_100_000_000) {
  console.error("Android versionCode must be an integer from 1 to 2,100,000,000");
  process.exit(1);
}
const semver = packageJson.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!semver) {
  console.error("package version must be stable semver (x.y.z) for Android releases");
  process.exit(1);
}
const expectedMinimumCode = Number(semver[1]) * 1_000_000 + Number(semver[2]) * 1_000 + Number(semver[3]);
if (androidCode < expectedMinimumCode) {
  console.error(`Android versionCode ${androidCode} is behind package version ${packageJson.version}; expected at least ${expectedMinimumCode}`);
  process.exit(1);
}
const configuredAndroidCode = tauri.bundle?.android?.versionCode;
if (configuredAndroidCode !== androidCode) {
  console.error("Android versionCode differs between tauri.conf.json and generated tauri.properties", {
    configuredAndroidCode,
    androidCode,
  });
  process.exit(1);
}
const requiredBackupMarkers = [
  'android:allowBackup="true"',
  'android:fullBackupContent="@xml/backup_rules"',
  'android:dataExtractionRules="@xml/data_extraction_rules"',
];
const missingBackupMarkers = requiredBackupMarkers.filter((marker) => !androidManifest.includes(marker));
const secureVaultFile = 'path="route_secure_storage.xml"';
if (missingBackupMarkers.length || !legacyBackupRules.includes(secureVaultFile) || !dataExtractionRules.includes(secureVaultFile)) {
  console.error("Android backup rules must exclude the Keystore-backed secure vault", {
    missingBackupMarkers,
    legacyVaultExcluded: legacyBackupRules.includes(secureVaultFile),
    dataExtractionVaultExcluded: dataExtractionRules.includes(secureVaultFile),
  });
  process.exit(1);
}
if (!notificationPlugin.includes("import android.os.UserManager") ||
    !notificationPlugin.includes("!userManager.isUserUnlocked") ||
    !notificationPlugin.includes("intent.action == Intent.ACTION_USER_UNLOCKED")) {
  console.error("Android background restore must defer credential-protected data until USER_UNLOCKED");
  process.exit(1);
}
if (!notificationPlugin.includes("readRaw(context)") ||
    !notificationPlugin.includes("val seenIds = HashSet<Int>()") ||
    !notificationPlugin.includes("cancelAlarm(context, id)") ||
    !notificationPlugin.includes("validEntry(") ||
    !notificationPlugin.includes("seenIds.add(id)") ||
    !notificationPlugin.includes("val active = read(context)") ||
    !notificationPlugin.includes("Do not iterate raw backup entries here")) {
  console.error("Android reminder restore must remove malformed/duplicate records and cancel their alarms");
  process.exit(1);
}
if (!notificationPlugin.includes("fun cancel(context: Context, title: String, atMillis: Long): Boolean") ||
    !notificationPlugin.includes("ReminderStore.cancel(activity, args.title, args.atMillis)") ||
    !notificationPlugin.includes("ReminderIdPolicy.availableId(title, atMillis, occupied)") ||
    !notificationPlugin.includes("if (removed.isEmpty()) return true") ||
    !fs.existsSync("src-tauri/gen/android/app/src/test/java/com/luyou/planner/ReminderIdPolicyTest.java")) {
  console.error("Reminder IDs must avoid occupied IDs; cancellation must preserve legacy records and be idempotent");
  process.exit(1);
}
const updaterPolicy = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/UpdatePolicy.kt", "utf8");
const updaterSource = fs.readFileSync("src-tauri/gen/android/app/src/main/java/com/luyou/planner/AndroidUpdaterPlugin.kt", "utf8");
if (!updaterPolicy.includes('fun normalizeVersion(value: String): String = value.trim().removePrefix("v")') ||
    updaterSource.includes('.split("-")[0]') ||
    !updaterSource.includes('UpdatePolicy.normalizeVersion(release.optString("tag_name"))')) {
  console.error("Android updater must reject prerelease suffixes instead of truncating them");
  process.exit(1);
}
if (!updaterSource.includes('File(activity.cacheDir, "updates")') ||
    !updaterSource.includes("cleanupLegacyExportDownloads()") ||
    !updaterSource.includes('val legacyDir = File(activity.cacheDir, "exports")') ||
    !fs.readFileSync("src-tauri/gen/android/app/src/main/res/xml/file_paths.xml", "utf8").includes('path="updates/"')) {
  console.error("Android updater artifacts must use a dedicated FileProvider cache path");
  process.exit(1);
}
if (!fs.existsSync(".github/workflows/release.yml")) {
  console.error("Release workflow is missing");
  process.exit(1);
}
if (packageJson.scripts?.dev !== "node server/dev-all.mjs" ||
    !devSupervisor.includes('process.loadEnvFile?.(envFile)') ||
    !devSupervisor.includes('--env-file-if-exists=.env') ||
    !devSupervisor.includes('server/auth-server.mjs') ||
    !devSupervisor.includes('Leave AUTH_ORIGINS unset') ||
    !devSupervisor.includes('localhost/127.0.0.1 Vite port') ||
    !devSupervisor.includes('findFreePort') ||
    !devSupervisor.includes('occupied.status > 0') ||
    !devSupervisor.includes('access-control-allow-origin') ||
    !devSupervisor.includes('VITE_AUTH_ENDPOINT') ||
    !devSupervisor.includes('useManagedAuthEndpoint') ||
    !devSupervisor.includes('configuredAuthEndpoint')) {
  console.error("Unified development entrypoint must load .env before starting the account service");
  process.exit(1);
}
if (!authServerSource.includes('function requestPath(req)') ||
    !authServerSource.includes('BAD_REQUEST_TARGET') ||
    !authServerSource.includes('req.url || ""') ||
    authServerSource.includes('new URL(req.url, `http://${req.headers.host || "localhost"}`)')) {
  console.error("Account service must validate origin-form request targets without trusting Host");
  process.exit(1);
}
if (!authServerSource.includes('NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"') ||
    !authServerSource.includes('headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"') ||
    !authServerSource.includes('"Content-Security-Policy": "default-src \'none\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'none\'"') ||
    !authServerSource.includes('"Permissions-Policy": "camera=(), geolocation=(), microphone=()"')) {
  console.error("Production account service must default to loopback and emit browser security headers");
  process.exit(1);
}
if (!weatherSource.includes('let locationFallback = false') ||
    !weatherSource.includes('CACHE_PREFIX}v2:') ||
    !weatherSource.includes('function legacyCacheKey') ||
    !weatherSource.includes('当前位置暂不可用') ||
    !weatherSource.includes('abortIfNeeded(options.signal)') ||
    !weatherSource.includes('export function saveWeatherBackup') ||
    !weatherSource.includes('来自行程备份的天气数据') ||
    !appSource.includes('saveWeatherBackup(')) {
  console.error("Weather must retain the destination forecast when the optional location request fails");
  process.exit(1);
}
if (!weatherRegistration.includes("status.configured === false") ||
    !weatherRegistration.includes("status.periodic.length === 0") ||
    !packageJson.scripts?.verify?.includes("npm run weather:registration-test")) {
  console.error("Foreground recovery must repair a missing WorkManager weather task");
  process.exit(1);
}
if (!appSource.includes('const weatherQueryKey = useRef("")') ||
    !appSource.includes('weatherQueryKey.current !== queryKey') ||
    !appSource.includes('setCurrentWeather(undefined)') ||
    !appSource.includes('const importedDates = parsedTrip.data.days.map((item) => item.date).join(",")') ||
    !appSource.includes('已恢复备份天气，正在刷新实时预报')) {
  console.error("Weather UI must clear the previous trip forecast before rendering a new query");
  process.exit(1);
}
const tripGenerationSource = fs.readFileSync("src/features/trip-generation.ts", "utf8");
if (!appSource.includes('import { parseTripContent } from "./features/trip-generation"') ||
    !tripGenerationSource.includes('result.destination !== request.destination.trim()') ||
    packageJson.scripts?.["trip:generation-test"] !== "node server/trip-generation-test.mjs" ||
    !packageJson.scripts?.verify?.includes("npm run trip:generation-test")) {
  console.error("AI-generated trip validation must reject destination mismatches and run its regression tests");
  process.exit(1);
}
const budgetSource = fs.readFileSync("src/features/budget.ts", "utf8");
if (!budgetSource.includes("over: total > budget") ||
    !budgetSource.includes("stillOver: estimatedTotal(first) > budget") ||
    packageJson.scripts?.["budget:test"] !== "node server/budget-test.mjs" ||
    !packageJson.scripts?.verify?.includes("npm run budget:test")) {
  console.error("Budget validation must handle zero-budget plans and run its regression test");
  process.exit(1);
}
if (!appSource.includes('Only Android has an explicit encrypted vault') ||
    !appSource.includes('Remove values written by older builds') ||
    !appSource.includes('else if (key === "route-ai-keys")')) {
  console.error("Non-Android builds must not persist AI keys in localStorage");
  process.exit(1);
}
if (!nativeBridge.includes('fn exceeds_chars(value: &str, maximum: usize)') ||
    !nativeBridge.includes('exceeds_chars(&request.destination, 120)') ||
    !nativeBridge.includes('exceeds_chars(&request.notes, 2_000)') ||
    !nativeBridge.includes('exceeds_chars(item, 40)')) {
  console.error("Native AI request limits must count Unicode characters consistently with the frontend");
  process.exit(1);
}
if (!nativeBridge.includes('async fn generate_agent(') ||
    !nativeBridge.includes('tauri::generate_handler![generate_trip, generate_agent]') ||
    !appSource.includes('invoke<string>("generate_agent"') ||
    !appSource.includes('validateAgentProposal(JSON.parse(content), context)')) {
  console.error("Single-user native builds must support AI itinerary assistant through the Keystore-backed API key");
  process.exit(1);
}
if (!shareBridge.includes('plugin:file-share|share_text", { filename, text, fileType: type }') ||
    !androidTestPage.includes('plugin:file-share|share_text", { filename: "途迹安卓测试.txt"') ||
    !androidTestPage.includes('fileType: "text/plain"')) {
  console.error("Android file-share command must pass the Tauri camelCase fileType argument");
  process.exit(1);
}
if (!fileSharePlugin.includes("createUniqueFile(directory, safeName.ifBlank") ||
    !fileSharePlugin.includes("ShareCachePolicy.reserve(directory, content.size.toLong())") ||
    !shareCachePolicy.includes("const val MAX_SHARE_FILES = 20") ||
    !shareCachePolicy.includes("const val MAX_SHARE_BYTES = 50L * 1024 * 1024") ||
    !shareCachePolicy.includes("RECENT_SHARE_MILLIS") ||
    !shareCachePolicy.includes("endsWith(\".apk\", ignoreCase = true)")) {
  console.error("Android sharing must avoid overwriting active exports and must not clean updater APKs");
  process.exit(1);
}
if (!androidTestPage.includes('plugin:notifications|schedule_notification", { title: "途迹测试通知"') ||
    !androidTestPage.includes("replaceExisting: false") ||
    !nativeBridge.includes("pub fn cancel_all_notifications") ||
    !nativeBridge.includes('run_mobile_plugin("cancelAll"') ||
    !notificationPlugin.includes("fun cancelAll(invoke: Invoke)") ||
    !notificationPlugin.includes("fun cancelAll(context: Context): Boolean") ||
    !tauriBuild.includes('"cancel_all_notifications"') ||
    !appSource.includes("plugin:notifications|cancel_all_notifications")) {
  console.error("Android notification diagnostics must append without replacing trip reminders");
  process.exit(1);
}
// The browser invokes Rust first, which then forwards the payload to Kotlin.
// Checking just the browser and Kotlin declarations misses dropped arguments.
const reminderHandler = nativeBridge.match(/pub fn schedule_notification\(([\s\S]*?)\n    pub fn cancel_notification/)?.[1] || "";
if (!reminderHandler.includes("replace_existing: Option<bool>") ||
    !reminderHandler.includes('"replaceExisting": replace_existing.unwrap_or(true)') ||
    !notificationPlugin.includes("var replaceExisting: Boolean = true") ||
    !notificationPlugin.includes("args.replaceExisting")) {
  console.error("Notification append/replace policy must pass through the Rust and Kotlin bridge");
  process.exit(1);
}
if (!tauriBuild.includes('"weather_monitor_status"') ||
    !androidTestPage.includes('plugin:weather-background|weather_monitor_status') ||
    !appSource.includes('import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true"') ||
    !appSource.includes('import.meta.env.DEV || import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS') ||
    !weatherPlugin.includes('fun status(invoke: Invoke)') ||
    !weatherPlugin.includes('preferences.edit().clear().commit()') ||
    !weatherPlugin.includes('"无法清除已结束的天气监测设置"') ||
    !weatherPlugin.includes('rawDates.size != dates.size') ||
    !weatherPlugin.includes('private const val MAX_MONITOR_DATES = 31') ||
    !weatherPlugin.includes('private const val WEATHER_NOTIFICATION_ID = 7814') ||
    !weatherPlugin.includes('private fun cancelWeatherNotification(context: Context)') ||
    !weatherPlugin.includes('if (changed) cancelWeatherNotification(activity)') ||
    !weatherPlugin.includes('cancelWeatherNotification(applicationContext)') ||
    !weatherPlugin.includes('rawDates.size <= MAX_MONITOR_DATES') ||
    !weatherPlugin.includes('cancel(context)') ||
    !weatherPlugin.includes('cancelCurrentWork()') ||
    !weatherPlugin.includes('cancelWorkById(id)') ||
    !weatherPlugin.includes('val configuration = synchronized(WeatherBackgroundLock)') ||
    !weatherPlugin.includes('Configuration(destination, generation, dates)') ||
    !weatherPlugin.includes('if (changed) editor.remove("lastAlert")') ||
    !weatherPlugin.includes('getSystemService(UserManager::class.java)') ||
    !weatherPlugin.includes('!userManager.isUserUnlocked') ||
    !appSource.includes('createWeatherRegistration') ||
    !appSource.includes('plugin:weather-background|weather_monitor_status') ||
    !appSource.includes('enqueueNativeCommand(weatherCommandQueue, () => registerWeather(initial))')) {
  console.error("Expired weather monitor configurations must be cleared before cancellation");
  process.exit(1);
}
if (!tauriBuild.includes('"request_location_permission", "location_permission_status"') ||
    !appSource.includes('plugin:location-permission|request_location_permission') ||
    !androidTestPage.includes('plugin:location-permission|location_permission_status') ||
    !androidTestPage.includes('plugin:location-permission|request_location_permission')) {
  console.error("Android location-permission command names must match the Rust Tauri command handlers");
  process.exit(1);
}
if (!appSource.includes('plugin:android-updater|install", androidUpdate') ||
    !androidTestPage.includes('plugin:android-updater|install", update') ||
    appSource.includes('plugin:android-updater|install", { release: androidUpdate }') ||
    androidTestPage.includes('plugin:android-updater|install", { release: update }') ||
    !appSource.includes('setAndroidUpdate(null)') ||
    !appSource.includes('setAvailableUpdate(null)')) {
  console.error("Android updater install calls must pass version and url directly to InstallArgs");
  process.exit(1);
}
if (!authSource.includes('const IS_TAURI_ANDROID') ||
    !authSource.includes('IS_TAURI_ANDROID ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787"') ||
    !authSource.includes('isTauri() && typeof navigator !== "undefined"')) {
  console.error("Development auth endpoint must distinguish a real Android Tauri WebView from a browser preview");
  process.exit(1);
}
if (!authSource.includes('const ACCOUNT_ENDPOINT_LOCKED') ||
    !authSource.includes('import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS !== "true"') ||
    !authSource.includes('正式版本的账号服务地址由发布配置固定') ||
    !authViewSource.includes('import.meta.env.PROD && import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS !== "true" ?') ||
    !authViewSource.includes('auth-endpoint__fixed')) {
  console.error("Production builds must pin the account endpoint and hide endpoint editing");
  process.exit(1);
}
if (!authSource.includes('(!import.meta.env.PROD || import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true") && parsed.protocol === "http:"')) {
  console.error("Local HTTP account endpoints must remain limited to development or the diagnostics build");
  process.exit(1);
}
if (!authSource.includes("validAuthPayloadResponse") ||
    !authSource.includes("validUserResponse") ||
    !authSource.includes("validAiResponse") ||
    !authSource.includes("validHealthResponse") ||
    !authSource.includes("AUTH_ENDPOINT_CHANGED_EVENT")) {
  console.error("Account client must validate authenticated response shapes before persisting or rendering them");
  process.exit(1);
}
if (!secureStoreSource.includes("let nativeOperationTail: Promise<void> = Promise.resolve()") ||
    !secureStoreSource.includes("const operation = nativeOperationTail.then(() => invoke<T>(command, args))") ||
    !secureStoreSource.includes("nativeOperationTail = operation.then(() => undefined, () => undefined)")) {
  console.error("Secure-storage retries must wait for timed-out native operations to settle");
  process.exit(1);
}
if (!checkinSource.includes("export function activityHistoricalStableKey") ||
    !checkinSource.includes("return `v2:") ||
    !checkinSource.includes("encodeURIComponent(JSON.stringify([") ||
    !checkinSource.includes("own(activityHistoricalStableKey(trip, dayIndex, index))")) {
  console.error("Check-in keys must be collision-safe while retaining historical records");
  process.exit(1);
}
if (!storageKeysSource.includes("encodeURIComponent(destination)") ||
    !storageKeysSource.includes("export function legacyStorageKey") ||
    packageJson.scripts?.["storage:key-test"] !== "node server/storage-key-test.mjs" ||
    !packageJson.scripts?.verify?.includes("npm run storage:key-test")) {
  console.error("Trip-scoped local storage keys must be collision-safe and migrate historical data");
  process.exit(1);
}
if (!authViewSource.includes('window.addEventListener("online", retryWhenVisible)') ||
    !authViewSource.includes('document.addEventListener("visibilitychange", retryWhenVisible)') ||
    !authViewSource.includes('if (attempts < 4)')) {
  console.error("Login service health status must recover from transient startup and network races");
  process.exit(1);
}
const updateHandler = nativeBridge.match(/pub fn install\(([\s\S]*?)\n    pub fn init\(/)?.[1] || "";
if (!["version: String", "url: String", "name: String"].every((argument) => updateHandler.includes(argument)) ||
    updateHandler.includes("release: Release") ||
    !updateHandler.includes('.run_mobile_plugin("install", Release { version, url, name })')) {
  console.error("Android updater Rust handler must accept flat frontend arguments and forward the Release to Kotlin");
  process.exit(1);
}
const requiredKeepClasses = [
  "AndroidUpdaterPlugin",
  "FileSharePlugin",
  "LocationPermissionPlugin",
  "MapLauncherPlugin",
  "NotificationPlugin",
  "SecureStoragePlugin",
  "WeatherBackgroundPlugin",
  "WeatherRiskWorker",
  "RouteReminderReceiver",
  "RouteReminderBootReceiver",
];
const missingKeepClasses = requiredKeepClasses.filter((name) => !proguardRules.includes(`-keep class com.luyou.planner.${name} { *; }`));
if (missingKeepClasses.length ||
    !proguardRules.includes("androidx.work.impl.WorkDatabase_Impl") ||
    !proguardRules.includes("extends androidx.room.RoomDatabase")) {
  console.error("Release ProGuard rules must keep Android native entry points:", missingKeepClasses);
  process.exit(1);
}
const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const requiredWorkflowMarkers = [
  "validation:",
  "needs: validation",
  "needs: [validation, windows]",
  "npm run verify:android",
  "persist-credentials: false",
  "Audit npm dependencies",
  "contents: read",
  "contents: write",
  "timeout-minutes:",
  "Configure updater repository",
  "assetName = $bundle.Name",
  "EscapeDataString($assetName)",
  "Verify Android APK before publishing",
  "apksigner\" verify --verbose",
  "aapt2\" dump badging",
  "version_name=$(grep '^tauri\\.android\\.versionName='",
  "for abi in arm64-v8a armeabi-v7a x86 x86_64",
  "missing embedded frontend index",
  "missing embedded frontend bundle",
  "sha256sum \"$apk\"",
  "Remove Android signing material",
  "releaseDraft: true",
  "Validate and publish complete release",
  "validateReleaseAssets",
  "already public; bump package.json",
];
const missingWorkflowMarkers = requiredWorkflowMarkers.filter((marker) => !workflow.includes(marker));
if (missingWorkflowMarkers.length) {
  console.error("Release workflow is missing required safety checks:", missingWorkflowMarkers);
  process.exit(1);
}
const windowsJob = workflow.match(/\n  windows:\n([\s\S]*?)(?=\n  android:\n|$)/)?.[1] || "";
const androidJob = workflow.match(/\n  android:\n([\s\S]*)$/)?.[1] || "";
if (!windowsJob.includes('VITE_ENABLE_ANDROID_DIAGNOSTICS: "false"') ||
    !androidJob.includes('VITE_ENABLE_ANDROID_DIAGNOSTICS: "false"')) {
  console.error("Windows and Android release jobs must disable the Android diagnostics surface");
  process.exit(1);
}
// 账号服务已从发布链路彻底移除（单人私人版不搭载任何账号服务）。
// 反向断言：workflow 里不得再出现端点注入或端点校验步骤，否则会重新引入
// "没配 VITE_AUTH_ENDPOINT 就无法发版"的强制依赖。
const authEndpointLeftovers = [
  ["VITE_AUTH_ENDPOINT", "账号服务地址注入"],
  ["release:frontend-config-check", "前端端点校验步骤"],
  ["Validate production frontend endpoint", "端点校验步骤名"],
].filter(([needle]) => workflow.includes(needle));
if (authEndpointLeftovers.length) {
  console.error(
    "Account service must stay out of the release workflow; remove:",
    authEndpointLeftovers.map(([, label]) => label),
  );
  process.exit(1);
}
if (!authServerSource.includes("AUTH_ORIGINS.has(\"*\")") ||
    !authServerSource.includes("AUTH_ORIGINS 不能使用通配符") ||
    !authServerSource.includes("HAS_EXPLICIT_AUTH_ORIGINS") ||
    !authServerSource.includes("isDevelopmentLoopbackOrigin(origin)") ||
    !authServerSource.includes('NODE_ENV === "production" || HAS_EXPLICIT_AUTH_ORIGINS')) {
  console.error("Development CORS port reuse must stay loopback-only and disabled by explicit or production configuration");
  process.exit(1);
}
// 单人私人版开关：GitHub Actions 不会读取 .env，必须由 workflow 显式注入。
// 允许两种写法（"true" 加引号 / 裸 true），但不允许 false 或缺失。
// 行首锚定 ^[ \t]* 是为了排除注释行：# VITE_ANDROID_SINGLE_USER: "true"
// 不算注入——否则删掉注入只留注释也能骗过检查。
const singleUserPattern = /^[ \t]*VITE_ANDROID_SINGLE_USER:[ \t]*"?true"?[ \t]*$/m;
if (!singleUserPattern.test(androidJob)) {
  console.error(
    "Android release job must inject VITE_ANDROID_SINGLE_USER: \"true\" " +
    "(the APK would otherwise ship with the account login gate)"
  );
  process.exit(1);
}
// 三步都必须带上：编译验证、单元测试、正式打包。任何一步缺失都说明有人删掉了注入。
const androidJobSteps = [
  "Run Android compile validation",
  "Run Android unit tests",
  "Build universal Android APK",
];
const stepsMissingSingleUser = androidJobSteps.filter((stepName) => {
  const step = androidJob.split(`- name: ${stepName}`)[1];
  if (!step) return true;
  // 只取当前 step 到下一个 step 之间的内容，避免把后续 step 的 env 误算进来
  const block = step.split("\n      - name: ")[0];
  return !singleUserPattern.test(block);
});
if (stepsMissingSingleUser.length) {
  console.error(
    "These Android release steps must export VITE_ANDROID_SINGLE_USER=\"true\":",
    stepsMissingSingleUser
  );
  process.exit(1);
}
// 变量名拼错（例如 VITE_ANDROID_SINGLE_USERS）也应当被发现
const singleUserTypo = androidJob.match(/VITE_ANDROID_SINGLE_USER\w+:/);
if (singleUserTypo) {
  console.error(`Unknown workflow variable (typo?): ${singleUserTypo[0]}`);
  process.exit(1);
}
// 应用锁不能存在"无验证重置"后门：任何能在不输入口令的情况下清除锁配置的
// 导出函数，都等于把应用锁变成装饰品。忘记口令只允许通过重装应用解决。
const appLockSource = fs.readFileSync("src/features/app-lock.ts", "utf8");
const appLockViewSource = fs.readFileSync("src/features/app-lock-view.tsx", "utf8");
if (/export\s+(async\s+)?function\s+forgetLock/.test(appLockSource) ||
    appLockViewSource.includes("forgetLock")) {
  console.error(
    "App lock must not expose an unauthenticated reset path " +
    "(forgetLock without biometric/recovery verification defeats the lock)"
  );
  process.exit(1);
}
if (appLockViewSource.includes("忘记口令")) {
  console.error("App lock settings must not render a password-free 忘记口令 escape hatch");
  process.exit(1);
}
console.log(`Release metadata OK: v${packageJson.version}, Android versionCode ${androidCode}`);
