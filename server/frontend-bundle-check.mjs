import fs from "node:fs";
import path from "node:path";

// Vite replaces import.meta.env at compile time. Verify the emitted files as
// well as the source gate so a future refactor cannot ship native diagnostics
// by accidentally restoring an unconditional dynamic import.
const assetsRoot = path.resolve("dist", "assets");
const diagnosticAssets = fs.readdirSync(assetsRoot).filter((name) =>
  /^android-test-.*\.(?:js|css)$/.test(name),
);
const previewAssets = fs.readdirSync(assetsRoot).filter((name) =>
  /^android-preview-.*\.(?:js|css)$/.test(name),
);
const diagnosticsEnabled = process.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true";
const hasJavascript = diagnosticAssets.some((name) => name.endsWith(".js"));
const hasPreviewJavascript = previewAssets.some((name) => name.endsWith(".js"));
const appJavascript = fs.readdirSync(assetsRoot)
  .filter((name) => /^index-.*\.js$/.test(name))
  .map((name) => fs.readFileSync(path.join(assetsRoot, name), "utf8"))
  .join("\n");
const endpointEditorPresent = appJavascript.includes("auth-endpoint__body");
if (diagnosticsEnabled ? !hasJavascript || !hasPreviewJavascript : diagnosticAssets.length > 0 || previewAssets.length > 0) {
  console.error(diagnosticsEnabled
    ? "Android acceptance bundle is missing its diagnostics or preview page"
    : `Production bundle contains Android-only tooling: ${[...diagnosticAssets, ...previewAssets].join(", ")}`);
  process.exit(1);
}
if (!diagnosticsEnabled && endpointEditorPresent) {
  console.error("Production bundle contains the editable account endpoint UI");
  process.exit(1);
}
console.log(`Frontend bundle OK: Android tooling ${diagnosticsEnabled ? "included for acceptance" : "excluded"}`);
