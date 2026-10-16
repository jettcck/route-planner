import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-production-transport-"));
const child = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    AUTH_PORT: String(port),
    // Intentionally omit AUTH_HOST: production must default to loopback.
    AUTH_HOST: undefined,
    AUTH_ORIGINS: "https://app.example.com",
    AI_API_KEY: "transport-test-key",
    AI_ENDPOINT: "https://api.example.com/chat/completions",
    AI_MODEL: "test-model",
    AUTH_DATA_DIR: dataDir,
    AUTH_LOG_LEVEL: "info",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

async function waitForStart() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.includes("Route auth service listening")) return;
    if (child.exitCode !== null) throw new Error(`production service exited ${child.exitCode}: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`production service startup timed out: ${output}`);
}

function request(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ response, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

try {
  await waitForStart();
  assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}`), "production default host must be loopback");
  const health = await request("/healthz");
  assert.equal(health.response.statusCode, 200);
  assert.equal(health.response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(
    health.response.headers["content-security-policy"],
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  assert.equal(health.response.headers["permissions-policy"], "camera=(), geolocation=(), microphone=()");
  const live = await request("/livez");
  assert.equal(live.response.statusCode, 200);
  console.log("Production transport defaults passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
