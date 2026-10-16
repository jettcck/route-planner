import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./error-boundary";
import { isTauri } from "@tauri-apps/api/core";

// Some Android WebViews report zero for CSS env(safe-area-inset-top) while
// drawing edge-to-edge. Mark the real native shell so its mobile header can
// apply a small status-bar fallback without changing the browser preview.
if (isTauri() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("android-native");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
);
