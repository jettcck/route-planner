import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { REQUIRED_RELEASE_FIELDS, releaseEnvironmentErrors } from "./release-env-check.mjs";

const sentinel = "test-secret-never-log-this";
const valid = Object.fromEntries(REQUIRED_RELEASE_FIELDS.map((name) => [name, sentinel]));
valid.VITE_AUTH_ENDPOINT = "https://account.example.com";
assert.deepEqual(releaseEnvironmentErrors(valid), []);

// 单人私人版不搭载账号服务：端点缺失必须是合法的构建配置。
// 这条断言是「移除发布链路账号依赖」的核心回归，防止有人把必填项加回去。
assert.ok(
  !REQUIRED_RELEASE_FIELDS.includes("VITE_AUTH_ENDPOINT"),
  "VITE_AUTH_ENDPOINT 不得回到 REQUIRED_RELEASE_FIELDS",
);
for (const value of [undefined, "", "   "]) {
  assert.deepEqual(
    releaseEnvironmentErrors({ ...valid, VITE_AUTH_ENDPOINT: value }),
    [],
    `VITE_AUTH_ENDPOINT=${JSON.stringify(value)} 应被视为「本构建不带账号服务」`,
  );
}

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
}const result = spawnSync(process.execPath, ["server/release-env-check.mjs"], {
  encoding: "utf8",
  timeout: 5_000,
  env: { ...process.env, ...valid, ANDROID_KEY_ALIAS: "", VITE_AUTH_ENDPOINT: "https://user:secret@account.example.com" },
});
assert.equal(result.status, 1);
const output = `${result.stdout}${result.stderr}`;
assert.ok(output.includes("ANDROID_KEY_ALIAS"));
assert.ok(!output.includes(sentinel) && !output.includes("user:secret"));
console.log("Release environment tests passed: account endpoint is optional; missing settings fail before builds; secret values are not printed");
