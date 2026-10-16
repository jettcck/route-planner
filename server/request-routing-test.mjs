import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-request-routing-"));
const child = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  env: { ...process.env, NODE_ENV: "test", AUTH_HOST: "127.0.0.1", AUTH_PORT: String(port), AUTH_DATA_DIR: dataDir, AUTH_LOG_LEVEL: "info" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
function request(target, host = "localhost") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: target, headers: { Host: host }, timeout: 2_000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 10_000);
    const started = (chunk) => {
      if (String(chunk).includes("Route auth service listening")) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", started);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    if (output.includes("Route auth service listening")) { clearTimeout(timer); resolve(); }
  });
  // Host is client-controlled and must never become the routing/log URL base.
  for (const host of ["[", "localhost:bad-port", "example.invalid"]) {
    const health = await request("/healthz?probe=1", host);
    assert.equal(health.status, 200, `health failed for Host ${host}: ${output}`);
    assert.equal(health.body.service, "route-auth");
  }
  for (const target of ["http://example.invalid/healthz", "//example.invalid/healthz", "/\\example.invalid/healthz"]) {
    const invalid = await request(target);
    assert.equal(invalid.status, 400, `accepted nonlocal request target ${target}`);
    assert.equal(invalid.body.code, "BAD_REQUEST_TARGET");
  }
  assert.equal((await request("/livez")).status, 200, `bad input terminated the service: ${output}`);
  assert.equal(child.exitCode, null);
  console.log("Account request routing safety test passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  }
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
