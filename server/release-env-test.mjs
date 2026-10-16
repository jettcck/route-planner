import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { REQUIRED_RELEASE_FIELDS, releaseEnvironmentErrors } from "./release-env-check.mjs";

const sentinel = "test-secret-never-log-this";
const valid = Object.fromEntries(REQUIRED_RELEASE_FIELDS.map((name) => [name, sentinel]));
valid.VITE_AUTH_ENDPOINT = "https://account.example.com";
assert.deepEqual(releaseEnvironmentErrors(valid), []);
// An unencrypted updater key has no password; AI credentials stay on the backend.
assert.deepEqual(releaseEnvironmentErrors({ ...valid, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", AI_API_KEY: "" }), []);
for (const field of REQUIRED_RELEASE_FIELDS) {
  for (const value of [undefined, "", "   "]) {
    assert.ok(releaseEnvironmentErrors({ ...valid, [field]: value }).some((error) => error.includes(field)));
  }
}
for (const value of ["invalid", "http://account.example.com", "https://user:password@account.example.com",
  "https://account.example.com?key=secret", "https://account.example.com#secret"]) {
  const errors = releaseEnvironmentErrors({ ...valid, VITE_AUTH_ENDPOINT: value });
  assert.ok(errors.length);
  assert.ok(errors.every((error) => !error.includes(value)));
}
const result = spawnSync(process.execPath, ["server/release-env-check.mjs"], {
  encoding: "utf8",
  timeout: 5_000,
  env: { ...process.env, ...valid, ANDROID_KEY_ALIAS: "", VITE_AUTH_ENDPOINT: "https://user:secret@account.example.com" },
});
assert.equal(result.status, 1);
const output = `${result.stdout}${result.stderr}`;
assert.ok(output.includes("ANDROID_KEY_ALIAS"));
assert.ok(!output.includes(sentinel) && !output.includes("user:secret"));
console.log("Release environment tests passed: missing settings fail before builds; secret values are not printed");
