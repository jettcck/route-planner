import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      finish();
    }, 2_000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-recovery-"));
const valid = { nextUserId: 1, users: [], sessions: [], codes: [] };
fs.writeFileSync(path.join(dataDir, "accounts.json"), "{broken", "utf8");
fs.writeFileSync(path.join(dataDir, "accounts.json.bak"), JSON.stringify(valid), "utf8");
const port = 19_000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  cwd: process.cwd(),
  env: { ...process.env, AUTH_HOST: "127.0.0.1", AUTH_PORT: String(port), AUTH_DATA_DIR: dataDir, AUTH_ORIGINS: "http://127.0.0.1:1420" },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`recovery server timeout: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Route auth service listening")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok || !fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8").includes("nextUserId")) throw new Error("backup was not restored");
  console.log("Account database recovery test passed");
} finally {
  await stopChild(child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// A syntactically valid but inconsistent primary file must also fall back to
// the backup. This catches duplicate IDs that would otherwise cause account
// lookups and next-user allocation to behave unpredictably.
const semanticDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-semantic-recovery-"));
const semanticBackup = {
  nextUserId: 2,
  users: [{ id: 1, email: null, phone: "13800138000", nickname: null, emailVerified: false, phoneVerified: true }],
  sessions: [],
  codes: [],
};
fs.writeFileSync(path.join(semanticDir, "accounts.json"), JSON.stringify({
  nextUserId: 2,
  users: [semanticBackup.users[0], { ...semanticBackup.users[0] }],
  sessions: [],
  codes: [],
}), "utf8");
fs.writeFileSync(path.join(semanticDir, "accounts.json.bak"), JSON.stringify(semanticBackup), "utf8");
const semanticPort = 19_500 + Math.floor(Math.random() * 400);
const semanticChild = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  cwd: process.cwd(),
  env: { ...process.env, AUTH_HOST: "127.0.0.1", AUTH_PORT: String(semanticPort), AUTH_DATA_DIR: semanticDir, AUTH_ORIGINS: "http://127.0.0.1:1420" },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`semantic recovery server timeout: ${output}`)), 10_000);
    semanticChild.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Route auth service listening")) { clearTimeout(timer); resolve(); }
    });
    semanticChild.stderr.on("data", (chunk) => { output += chunk; });
    semanticChild.on("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${semanticPort}/healthz`);
  const restored = JSON.parse(fs.readFileSync(path.join(semanticDir, "accounts.json"), "utf8"));
  if (!response.ok || restored.users.length !== 1 || restored.users[0].id !== 1) throw new Error("semantic backup was not restored");
  console.log("Semantic account database recovery test passed");
} finally {
  await stopChild(semanticChild);
  fs.rmSync(semanticDir, { recursive: true, force: true });
}

// A crash between writing the temporary file and renaming it must preserve
// the newest valid account mutation instead of falling back to an older .bak.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-temp-recovery-"));
const tempPrimary = { nextUserId: 1, users: [], sessions: [], codes: [] };
const tempLatest = {
  nextUserId: 2,
  users: [{ id: 1, email: null, phone: "13800138000", nickname: null, emailVerified: false, phoneVerified: true }],
  sessions: [],
  codes: [],
};
fs.writeFileSync(path.join(tempDir, "accounts.json"), JSON.stringify(tempPrimary), "utf8");
const interruptedTemp = path.join(tempDir, "accounts.json.tmp");
fs.writeFileSync(interruptedTemp, JSON.stringify(tempLatest), "utf8");
const future = new Date(Date.now() + 2_000);
fs.utimesSync(interruptedTemp, future, future);
const tempPort = 20_000 + Math.floor(Math.random() * 400);
const tempChild = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], {
  cwd: process.cwd(),
  env: { ...process.env, AUTH_HOST: "127.0.0.1", AUTH_PORT: String(tempPort), AUTH_DATA_DIR: tempDir, AUTH_ORIGINS: "http://127.0.0.1:1420" },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  let tempOutput = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`temporary recovery server timeout: ${tempOutput}`)), 10_000);
    const finish = () => { clearTimeout(timer); resolve(); };
    tempChild.stdout.on("data", (chunk) => {
      tempOutput += chunk;
      if (tempOutput.includes("Route auth service listening")) finish();
    });
    tempChild.stderr.on("data", (chunk) => { tempOutput += chunk; });
    tempChild.on("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${tempPort}/healthz`);
  const restored = JSON.parse(fs.readFileSync(path.join(tempDir, "accounts.json"), "utf8"));
  if (!response.ok || restored.nextUserId !== 2 || restored.users.length !== 1) {
    throw new Error(`temporary account database was not recovered: ${JSON.stringify({ status: response.status, nextUserId: restored.nextUserId, users: restored.users.length, tempExists: fs.existsSync(interruptedTemp), files: fs.readdirSync(tempDir), output: tempOutput })}`);
  }
  console.log("Temporary account database recovery test passed");
} finally {
  await stopChild(tempChild);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
