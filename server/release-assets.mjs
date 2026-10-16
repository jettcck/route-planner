import assert from "node:assert/strict";

export function requireEditableDraft(release) {
  assert.equal(release.draft, true,
    "This version is already public. Bump the app version instead of replacing published update assets.");
}

/** Gate publication on the exact asset named by the desktop updater manifest. */
export function validateReleaseAssets(release, manifest, { repository, version }) {
  requireEditableDraft(release);
  assert.equal(release.tag_name, `v${version}`, "Release tag does not match app version");
  assert.equal(release.prerelease, false, "Production release cannot be a prerelease");
  assert.equal(manifest.version, version, "Updater manifest version does not match app version");
  const desktop = manifest.platforms?.["windows-x86_64"];
  assert.ok(typeof desktop?.signature === "string" && desktop.signature.trim(), "Missing Windows updater signature");
  const assetUrl = new URL(desktop.url);
  assert.equal(assetUrl.origin, "https://github.com", "Updater installer must be hosted on GitHub");
  assert.ok(!assetUrl.username && !assetUrl.password && !assetUrl.search && !assetUrl.hash,
    "Invalid updater installer URL");
  const prefix = `/${repository}/releases/download/v${version}/`;
  assert.ok(assetUrl.pathname.startsWith(prefix), "Updater URL points at a different repository or version");
  const installer = decodeURIComponent(assetUrl.pathname.slice(prefix.length));
  assert.ok(installer.endsWith(".exe") && !installer.includes("/") && !installer.includes("\\"),
    "Updater URL must name a Windows installer asset");
  const apk = `route-planner-${version}-android.apk`;
  const required = [installer, `${installer}.sig`, "latest.json", apk, `${apk}.sha256`];
  for (const name of required) {
    const matches = release.assets.filter((asset) => asset.name === name);
    assert.equal(matches.length, 1, `Release must contain exactly one ${name}`);
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0, `Release asset is empty: ${name}`);
    assert.equal(matches[0].state, "uploaded", `Release asset upload is incomplete: ${name}`);
  }
  return required;
}
