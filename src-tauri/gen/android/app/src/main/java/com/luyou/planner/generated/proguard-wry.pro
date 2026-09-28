# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.luyou.planner.* {
  native <methods>;
}

-keep class com.luyou.planner.WryActivity {
  public <init>(...);

  void setWebView(com.luyou.planner.RustWebView);
  java.lang.Class getAppClass(...);
  int getId();
  java.lang.String getVersion();
  int startActivity(...);
}

-keep class com.luyou.planner.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.luyou.planner.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.luyou.planner.RustWebChromeClient,com.luyou.planner.RustWebViewClient {
  public <init>(...);
}
