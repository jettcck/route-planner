import assert from "node:assert/strict";
import { requireEditableDraft, validateReleaseAssets } from "./release-assets.mjs";

const configuration = { repository: "example/route", version: "0.3.9" };
const installer = "途迹 Route_0.3.9_x64-setup.exe";
const manifest = {
  version: configuration.version,
  platforms: { "windows-x86_64": {
    signature: "test-signature",
    url: `https://github.com/example/route/releases/download/v0.3.9/${encodeURIComponent(installer)}`,
  } },
};
const names = [installer, `${installer}.sig`, "latest.json", "route-planner-0.3.9-android.apk", "route-planner-0.3.9-android.apk.sha256"];
const release = {
  draft: true, prerelease: false, tag_name: "v0.3.9",
  assets: names.map((name) => ({ name, size: 100, state: "uploaded" })),
};
assert.deepEqual(validateReleaseAssets(release, manifest, configuration), names);
assert.throws(() => requireEditableDraft({ ...release, draft: false }), /already public/);
for (const name of names) {
  assert.throws(() => validateReleaseAssets({ ...release, assets: release.assets.filter((asset) => asset.name !== name) }, manifest, configuration));
}
for (const change of [{ size: 0 }, { state: "new" }]) {
  assert.throws(() => validateReleaseAssets({ ...release, assets: release.assets.map((asset, index) => index === 3 ? { ...asset, ...change } : asset) }, manifest, configuration));
}
assert.throws(() => validateReleaseAssets({ ...release, assets: [...release.assets, release.assets[3]] }, manifest, configuration));
for (const url of [
  "https://github.com/other/route/releases/download/v0.3.9/route.exe",
  "https://github.com/example/route/releases/download/v0.2.0/route.exe",
  "https://evil.example/example/route/releases/download/v0.3.9/route.exe",
  "https://github.com/example/route/releases/download/v0.3.9/route.exe?download=1",
]) {
  const changed = structuredClone(manifest);
  changed.platforms["windows-x86_64"].url = url;
  assert.throws(() => validateReleaseAssets(release, changed, configuration));
}
assert.throws(() => validateReleaseAssets(release, { ...manifest, version: "0.2.0" }, configuration));
console.log("Release publication gate passed: incomplete assets and public version replacements rejected");
