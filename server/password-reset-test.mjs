import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-password-reset-"));
const port = 19_000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "test", AUTH_HOST: "127.0.0.1", AUTH_PORT: String(port), AUTH_DATA_DIR: dataDir, AUTH_ORIGINS: "http://127.0.0.1:1420", AUTH_ALLOW_PUBLIC_SIGNUP: "true", AUTH_ALLOW_PASSWORD_RESET: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
const waitForStart = new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`password reset service start timeout: ${output}`)), 10_000);
  child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("Route auth service listening")) { clearTimeout(timer); resolve(); } });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", reject);
});
async function call(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}
try {
  await waitForStart;
  const email = `9${Date.now().toString().slice(-9)}@qq.com`;
  const oldPassword = "OldPass123";
  const newPassword = "NewPass456";
  const registered = await call("/api/auth/email/register", { email, password: oldPassword });
  assert.equal(registered.response.status, 200);
  const sent = await call("/api/auth/password/reset/send", { email });
  assert.equal(sent.response.status, 200);
  assert.match(sent.body.devCode, /^\d{6}$/);
  const reset = await call("/api/auth/password/reset", { email, code: sent.body.devCode, password: newPassword });
  assert.equal(reset.response.status, 200);
  const oldLogin = await call("/api/auth/email/login", { email, password: oldPassword });
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await call("/api/auth/email/login", { email, password: newPassword });
  assert.equal(newLogin.response.status, 200);
  console.log("Password reset end-to-end test passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
