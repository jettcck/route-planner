import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const externalBase = String(process.env.AUTH_SMOKE_URL || "").trim();
let base = externalBase ? externalBase.replace(/\/+$/, "") : "";
let ownedService = null;
let ownedDataDir = null;

function cleanupOwnedData(attempt = 0) {
  if (!ownedDataDir) return;
  const directory = ownedDataDir;
  try {
    // Removing the directory recursively in one Windows call can report
    // success while leaving the directory behind when a child just released
    // a file handle. Remove entries first, then remove the empty directory.
    removeDirectoryContents(directory);
    fs.rmdirSync(directory);
    ownedDataDir = null;
  } catch (error) {
    // Windows can keep the account file open for a short time after SIGTERM.
    // Retry while the test process is still alive, but never keep a failed
    // cleanup loop running forever.
    if (attempt < 30) {
      setTimeout(() => cleanupOwnedData(attempt + 1), 100);
    } else {
      console.error(`Unable to remove temporary smoke database ${directory}: ${error?.message || error}`);
    }
  }
}

function removeDirectoryContents(directory) {
  for (const entry of fs.readdirSync(directory)) {
    const target = path.join(directory, entry);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      removeDirectoryContents(target);
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  }
}

function stopOwnedService() {
  if (ownedService && ownedService.exitCode === null && ownedService.signalCode === null) {
    ownedService.once("close", () => cleanupOwnedData());
    if (process.platform === "win32" && ownedService.pid) {
      // A smoke service is disposable. Terminate its complete tree so a
      // Windows Node child cannot keep the temporary database directory open
      // after the parent test has finished.
      const killer = spawn("taskkill", ["/PID", String(ownedService.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        try { ownedService.kill(); } catch { /* already exited */ }
      });
    } else {
      try { ownedService.kill("SIGTERM"); } catch { /* already exited */ }
    }
    // Also retry independently in case the child does not emit an exit event
    // before the parent starts its own shutdown.
    setTimeout(() => cleanupOwnedData(), 100);
  } else {
    cleanupOwnedData();
  }
}

process.once("exit", stopOwnedService);
process.once("SIGINT", () => {
  stopOwnedService();
  process.exitCode = 130;
});
process.once("uncaughtException", (error) => {
  console.error(error?.stack || error);
  stopOwnedService();
  process.exitCode = 1;
});
process.once("unhandledRejection", (error) => {
  console.error(error?.stack || error);
  stopOwnedService();
  process.exitCode = 1;
});

async function ensureService() {
  if (externalBase) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  ownedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-smoke-"));
  // The smoke service is deliberately isolated from developer .env values so
  // a production endpoint, AI key, or persistent data path cannot leak into
  // the disposable test process.
  ownedService = spawn(process.execPath, ["server/auth-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      AUTH_HOST: "127.0.0.1",
      AUTH_PORT: String(port),
      AUTH_ORIGINS: "",
      AUTH_DATA_DIR: ownedDataDir,
      AUTH_LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/livez");
      if (response.ok) return;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("local auth service did not start");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  let body = {};
  try { body = await response.json(); } catch { /* response diagnostics below */ }
  return { response, body };
}

await ensureService();

const health = await call("/healthz", { headers: { Origin: "http://127.0.0.1:1420" } });
if (health.response.status !== 200 || health.body.ok !== true) throw new Error(`healthz failed: ${health.response.status}`);
const ready = await call("/readyz");
if (ready.response.status !== 200 || ready.body.ok !== true) throw new Error(`readyz failed: ${ready.response.status}`);
const live = await call("/livez");
if (live.response.status !== 200 || live.body.ok !== true || live.body.live !== true) throw new Error(`livez failed: ${live.response.status}`);
if (!health.response.headers.get("x-request-id")) throw new Error("request id header missing");
if (health.response.headers.get("access-control-allow-origin") !== "http://127.0.0.1:1420") throw new Error("CORS allowlist check failed");
const alternateDevOrigin = await call("/healthz", { headers: { Origin: "http://localhost:1423" } });
if (alternateDevOrigin.response.headers.get("access-control-allow-origin") !== "http://localhost:1423") {
  throw new Error("development CORS did not accept a reused Vite port");
}
const untrustedOrigin = await call("/healthz", { headers: { Origin: "https://evil.example" } });
if (untrustedOrigin.response.headers.has("access-control-allow-origin")) {
  throw new Error("development CORS accepted an untrusted origin");
}

const sms = await call("/api/auth/code/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ channel: "sms", target: "13800138000" }),
});
if (sms.response.status !== 410 || sms.body.code !== "SMS_DISABLED") throw new Error(`SMS pause check failed: ${sms.response.status}`);

const oversized = await call("/api/auth/email/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ padding: "x".repeat(40_000) }),
});
if (oversized.response.status !== 413 || oversized.body.code !== "BODY_TOO_LARGE") throw new Error(`body limit check failed: ${oversized.response.status}`);

const afterOversized = await call("/healthz");
if (afterOversized.response.status !== 200 || afterOversized.body.ok !== true) throw new Error("connection recovery after oversized body failed");

// Keep-Alive regression: when Content-Length already exceeds the limit, the
// server must drain the body before reusing the socket for another request.
const keepAliveAgent = new http.Agent({ keepAlive: true });
const requestWithAgent = (path, options = {}, body = "") => new Promise((resolve, reject) => {
  const request = http.request(new URL(`${base}${path}`), { ...options, agent: keepAliveAgent }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* status assertion below */ }
      resolve({ response, body: parsed });
    });
  });
  request.on("error", reject);
  request.end(body);
});
try {
  const oversizedKeepAlive = await requestWithAgent("/api/auth/email/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "40000" },
  }, "{".padEnd(40_000, "x"));
  if (oversizedKeepAlive.response.statusCode !== 413) throw new Error("keep-alive oversized request was not rejected");
  const recoveredKeepAlive = await requestWithAgent("/healthz", { method: "GET" });
  if (recoveredKeepAlive.response.statusCode !== 200 || recoveredKeepAlive.body.ok !== true) {
    throw new Error("keep-alive connection was not reusable after oversized request");
  }
} finally {
  keepAliveAgent.destroy();
}

// Regression check for multibyte request data: the server must decode UTF-8
// only after all network chunks have been joined, otherwise a Chinese byte
// sequence split across chunks can become replacement characters.
const unicodeEmail = `997${Date.now().toString().slice(-8)}@qq.com`;
const unicodePayload = JSON.stringify({ email: unicodeEmail, password: "TestPass123", nickname: "北京·雨中漫步" });
const unicodeResponse = await new Promise((resolve, reject) => {
  const request = http.request(new URL(`${base}/api/auth/email/register`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(unicodePayload),
    },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      try { resolve({ response, body: JSON.parse(text) }); } catch (error) { reject(error); }
    });
  });
  request.on("error", reject);
  const splitAt = unicodePayload.indexOf("雨");
  const first = Buffer.from(unicodePayload.slice(0, splitAt), "utf8");
  const second = Buffer.from(unicodePayload.slice(splitAt), "utf8");
  request.write(first);
  // Split inside the first Chinese code point rather than on a JS character
  // boundary to exercise the byte-safe decoder.
  const splitBytes = Buffer.from("北京·", "utf8").length + 1;
  request.write(second.subarray(0, splitBytes));
  request.end(second.subarray(splitBytes));
});
if (unicodeResponse.response.statusCode !== 200 || unicodeResponse.body.ok !== true) throw new Error("UTF-8 fragmented request failed");

const wrongType = await call("/api/auth/email/login", {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: "{}",
});
if (wrongType.response.status !== 415 || wrongType.body.code !== "UNSUPPORTED_MEDIA_TYPE") throw new Error(`content type check failed: ${wrongType.response.status}`);

const nullBody = await call("/api/auth/email/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "null",
});
if (nullBody.response.status !== 400 || nullBody.body.code !== "INVALID_INPUT") throw new Error(`null body validation failed: ${nullBody.response.status}`);

const unauthenticated = await call("/api/ai/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ request: { destination: "上海", days: 1 } }),
});
if (unauthenticated.response.status !== 401 || unauthenticated.body.code !== "UNAUTHORIZED") throw new Error(`auth check failed: ${unauthenticated.response.status}`);

const unauthenticatedLogout = await call("/api/auth/logout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
if (unauthenticatedLogout.response.status !== 401 || unauthenticatedLogout.body.code !== "UNAUTHORIZED") throw new Error(`unauthenticated logout check failed: ${unauthenticatedLogout.response.status}`);

const invalidDate = await call("/api/ai/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-session" },
  body: JSON.stringify({ request: { destination: "上海", days: 1, travelers: 1, budget: 1000, startDate: "2026-02-30", interests: [], notes: "" } }),
});
if (invalidDate.response.status !== 401 || invalidDate.body.code !== "UNAUTHORIZED") throw new Error(`auth precedence check failed: ${invalidDate.response.status}`);

const uniqueEmail = `999${Date.now().toString().slice(-8)}@qq.com`;
for (let attempt = 0; attempt < 5; attempt += 1) {
  await call("/api/auth/email/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail, password: "WrongPass123" }),
  });
}
const locked = await call("/api/auth/email/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: uniqueEmail, password: "WrongPass123" }),
});
if (locked.response.status !== 429 || locked.body.code !== "LOGIN_LOCKED") throw new Error(`login lock check failed: ${locked.response.status}`);
if (locked.response.headers.get("retry-after") !== "900") throw new Error("login lock retry header missing");

const multiDeviceEmail = `998${Date.now().toString().slice(-8)}@qq.com`;
const created = await call("/api/auth/email/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: multiDeviceEmail, password: "TestPass123" }),
});
if (created.response.status !== 200) throw new Error("multi-device setup failed");
const sessions = [created.body.token];
for (let index = 0; index < 5; index += 1) {
  const login = await call("/api/auth/email/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: multiDeviceEmail, password: "TestPass123" }),
  });
  if (login.response.status !== 200) throw new Error("multi-device login failed");
  sessions.push(login.body.token);
}
const oldestSession = await call("/api/me", { headers: { Authorization: `Bearer ${sessions[0]}` } });
const newestSession = await call("/api/me", { headers: { Authorization: `Bearer ${sessions.at(-1)}` } });
if (oldestSession.response.status !== 401 || newestSession.response.status !== 200) throw new Error("multi-device session retention failed");

const loggedOut = await call("/api/auth/logout", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessions.at(-1)}` },
  body: "{}",
});
if (loggedOut.response.status !== 200 || loggedOut.body.action !== "logged_out") throw new Error("authenticated logout failed");
const afterLogout = await call("/api/me", { headers: { Authorization: `Bearer ${sessions.at(-1)}` } });
if (afterLogout.response.status !== 401 || afterLogout.body.code !== "UNAUTHORIZED") throw new Error("logged-out session remained valid");

const expiredSession = await call("/api/me", { headers: { Authorization: "Bearer expired-session-test" } });
if (expiredSession.response.status !== 401 || expiredSession.body.code !== "UNAUTHORIZED") throw new Error("expired session check failed");

console.log(`Auth smoke test passed: ${base}`);
stopOwnedService();
