package com.luyou.planner

import android.os.Bundle
import android.os.Build
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Android WebView does not consistently expose CSS safe-area insets when
    // the activity is edge-to-edge. Apply the actual system-bar insets at the
    // native boundary so the brand header and bottom navigation cannot sit
    // underneath status/navigation bars on devices where env(safe-area-inset-*)
    // is reported as zero.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val statusBarFallback = systemBarHeight("status_bar_height")
      val navigationBarFallback = systemBarHeight("navigation_bar_height")
      view.setPadding(
        view.paddingLeft,
        maxOf(bars.top, statusBarFallback),
        view.paddingRight,
        maxOf(bars.bottom, navigationBarFallback),
      )
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private fun systemBarHeight(name: String): Int {
    val resource = resources.getIdentifier(name, "dimen", "android")
    return if (resource == 0) 0 else resources.getDimensionPixelSize(resource)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Keep the WebView content below the status/navigation bars. The visual
    // shell already owns its dark header, so drawing the document underneath a
    // transparent status bar only causes the clock to overlap the brand mark
    // on devices that do not expose CSS safe-area values.
    WindowCompat.setDecorFitsSystemWindows(window, true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    // The app shell uses a dark brand bar behind the transparent edge-to-edge
    // system bars. Explicitly request light system-bar icons; relying on the
    // theme default leaves the emulator/device clock and status icons dark and
    // unreadable on the first screen.
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    // A reminder alarm can fire while Android notification permission or its
    // channel is disabled. Flush those due entries when the user returns after
    // enabling notifications so they are not silently lost.
    runCatching { ReminderStore.flushDue(this) }
      .onFailure { Log.w("RouteReminders", "Unable to recover due reminders", it) }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    NotificationPermissionHelper.onRequestPermissionsResult(requestCode)
  }
}
