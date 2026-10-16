# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# These classes are instantiated by Tauri through JNI using their fully
# qualified names, and the worker/receivers are loaded by Android or
# WorkManager from manifest/persisted class names. Keep both names and members
# so a minified Release build cannot silently break native features.
-keep class com.luyou.planner.AndroidUpdaterPlugin { *; }
-keep class com.luyou.planner.FileSharePlugin { *; }
-keep class com.luyou.planner.LocationPermissionPlugin { *; }
-keep class com.luyou.planner.MapLauncherPlugin { *; }
-keep class com.luyou.planner.NotificationPlugin { *; }
-keep class com.luyou.planner.SecureStoragePlugin { *; }
-keep class com.luyou.planner.WeatherBackgroundPlugin { *; }
-keep class com.luyou.planner.WeatherRiskWorker { *; }
-keep class com.luyou.planner.RouteReminderReceiver { *; }
-keep class com.luyou.planner.RouteReminderBootReceiver { *; }

# WorkManager creates its Room database implementation reflectively during
# AndroidX Startup. R8 can otherwise remove the generated zero-argument
# constructor, which makes every minified Release APK crash before MainActivity
# is created with NoSuchMethodException: WorkDatabase_Impl.<init>.
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
-keep class androidx.work.impl.WorkDatabase_Impl$* { *; }
-keep class * extends androidx.room.RoomDatabase { *; }
