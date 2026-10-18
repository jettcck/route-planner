#!/usr/bin/env node
/**
 * 单人私人版的账号策略回归测试。
 *
 * 断言（全部以「默认不配置」的环境变量为准，模拟正式部署）：
 *  1. 公开注册默认关闭 → 403 SIGNUP_DISABLED
 *  2. 短信登录默认关闭 → 410 SMS_DISABLED
 *  3. 自助密码重置默认关闭 → 403 RESET_DISABLED
 *  4. /healthz 暴露的 capabilities 与实际策略一致
 *  5. create-account.mjs 建出的账号可以正常登录，且密码只存 scrypt 摘要
 *  6. 开启 AUTH_ALLOW_PUBLIC_SIGNUP=true 后注册恢复（确认开关有效，不是写死）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-single-user-"));
const dirs = [dataDir];
const children = [];

function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server/auth-server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "development",
      AUTH_HOST: "127.0.0.1",
      AUTH_PORT: String(port),
      AUTH_ORIGINS: "http://127.0.0.1:1420",
      AUTH_DATA_DIR: dataDir,
      AUTH_LOG_LEVEL: "silent",
      // 明确清空三个开关，避免开发机 .env 影响断言
      AUTH_ALLOW_PUBLIC_SIGNUP: "",
      AUTH_ALLOW_SMS_LOGIN: "",
      AUTH_ALLOW_PASSWORD_RESET: "",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitReady(base) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`服务未在 10 秒内就绪：${base}`);
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(args) {
  const result = spawn(process.execPath, ["server/create-account.mjs", ...args], {
    cwd: root,
    env: { ...process.env, AUTH_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  result.stdout.on("data", (chunk) => { stdout += chunk; });
  result.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    result.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  // ------------------------------------------------- 先建号（服务启动时只读一次库）
  const created = await runCli(["--email", "123456@qq.com", "--password", "Abc12345", "--nickname", "测试"]);
  assert(created.code === 0, `建号失败：${created.stderr}`);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8"));
  assert(raw.users.length === 1, "账号库应有 1 个账号");
  const stored = raw.users[0];
  assert(!("password" in stored), "账号库不得存明文密码");
  assert(/^[0-9a-f]{64}$/.test(stored.passwordHash), "passwordHash 应为 64 位十六进制");
  assert(!JSON.stringify(raw).includes("Abc12345"), "账号库中出现了明文密码");

  // ---------------------------------------------------------------- 默认策略
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  startServer(port);
  await waitReady(base);

  const health = await (await fetch(`${base}/healthz`)).json();
  // ok() 把字段平铺在根节点，没有 data 包装层。
  assert(health?.capabilities, "healthz 未返回 capabilities");
  assert(health.capabilities.signup === false, "默认应关闭公开注册");
  assert(health.capabilities.sms === false, "默认应关闭短信登录");
  assert(health.capabilities.passwordReset === false, "默认应关闭密码重置");

  const register = await post(base, "/api/auth/email/register", { email: "123456@qq.com", password: "Abc12345" });
  assert(register.status === 403 && register.body?.code === "SIGNUP_DISABLED", `注册应被拒绝，实际 ${register.status}/${register.body?.code}`);

  const sms = await post(base, "/api/auth/code/send", { channel: "sms", target: "13800138000" });
  assert(sms.status === 410 && sms.body?.code === "SMS_DISABLED", `短信应被拒绝，实际 ${sms.status}/${sms.body?.code}`);

  const reset = await post(base, "/api/auth/password/reset/send", { email: "123456@qq.com" });
  assert(reset.status === 403 && reset.body?.code === "RESET_DISABLED", `密码重置应被拒绝，实际 ${reset.status}/${reset.body?.code}`);

  // ---------------------------------------------------------------- 本机建号可登录
  const login = await post(base, "/api/auth/email/login", { email: "123456@qq.com", password: "Abc12345" });
  assert(login.status === 200 && typeof login.body?.token === "string", `建号后应能登录，实际 ${login.status}`);

  const badLogin = await post(base, "/api/auth/email/login", { email: "123456@qq.com", password: "Wrong12345" });
  assert(badLogin.status === 401, "错误密码应返回 401");

  // ------------------------------------------------- 开关打开后注册恢复（确认可配）
  const port2 = await freePort();
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "route-signup-on-"));
  dirs.push(dataDir2);
  const base2 = `http://127.0.0.1:${port2}`;
  startServer(port2, { AUTH_ALLOW_PUBLIC_SIGNUP: "true", AUTH_DATA_DIR: dataDir2 });
  await waitReady(base2);
  const health2 = await (await fetch(`${base2}/healthz`)).json();
  assert(health2.capabilities.signup === true, "开关打开后 capabilities.signup 应为 true");
  const register2 = await post(base2, "/api/auth/email/register", { email: "654321@qq.com", password: "Abc12345" });
  assert(register2.status === 200, `开关打开后注册应成功，实际 ${register2.status}`);

  process.stdout.write("单人版账号策略测试通过：注册/短信/重置默认关闭，本机建号可登录，开关可配置\n");
} finally {
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
  }
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
