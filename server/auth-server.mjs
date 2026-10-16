import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentContextSchema, validateAgentProposal, AGENT_SYSTEM_PROMPT } from "../shared/travel-agent.mjs";

// Render injects PORT; keep AUTH_PORT for local and Docker deployments.
const PORT = Number(process.env.AUTH_PORT || process.env.PORT || 8787);
const NODE_ENV = String(process.env.NODE_ENV || "development").trim().toLowerCase();
// Development keeps the host reachable from the Android emulator through
// 10.0.2.2. Production defaults to loopback so a deployment cannot
// accidentally expose this plain-HTTP origin directly; put it behind an
// HTTPS reverse proxy, or set AUTH_HOST explicitly when that is intentional.
const HOST = process.env.AUTH_HOST || (NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
const AUTH_ORIGINS = new Set(
  String(process.env.AUTH_ORIGINS || "http://localhost:1420,http://127.0.0.1:1420,http://localhost,http://tauri.localhost,https://tauri.localhost")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const DATA_DIR = path.resolve(process.env.AUTH_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data"));
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const BACKUP_FILE = `${DATA_FILE}.bak`;
const TEMP_FILE = `${DATA_FILE}.tmp`;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 32 * 1024;
const MAX_AGENT_BODY = 256 * 1024;
const MAX_AI_RESPONSE = 256 * 1024;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const AI_API_KEY = String(process.env.AI_API_KEY || "").trim();
const AI_ENDPOINT = String(process.env.AI_ENDPOINT || "https://api.deepseek.com/chat/completions").trim();
const AI_MODEL = String(process.env.AI_MODEL || "deepseek-chat").trim();
const HAS_EXPLICIT_AUTH_ORIGINS = Boolean(String(process.env.AUTH_ORIGINS || "").trim());
const LOG_LEVEL = String(process.env.AUTH_LOG_LEVEL || (NODE_ENV === "production" ? "info" : "debug")).trim().toLowerCase();
const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const activeLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;
const TAURI_APP_ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost"]);

function isTauriAppOrigin(origin) {
  return TAURI_APP_ORIGINS.has(origin);
}

function isDevelopmentLoopbackOrigin(origin) {
  if (NODE_ENV === "production" || HAS_EXPLICIT_AUTH_ORIGINS) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.username === "" && parsed.password === "" &&
      parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function log(level, message, details) {
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) > activeLogLevel) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  (level === "error" ? console.error : console.log)(`[${level}] ${message}${payload}`);
}

function validateConfig() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("AUTH_PORT 必须是 1~65535 的整数");
  if (AUTH_ORIGINS.has("*")) {
    throw new Error("AUTH_ORIGINS 不能使用通配符 *，请填写精确来源");
  }
  let endpoint;
  try { endpoint = new URL(AI_ENDPOINT); } catch { throw new Error("AI_ENDPOINT 不是有效 URL"); }
  const localEndpoint = endpoint.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/i.test(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !localEndpoint) || endpoint.username || endpoint.password || !endpoint.hostname || endpoint.search || endpoint.hash) {
    throw new Error("AI_ENDPOINT 必须使用 HTTPS，本地调试才允许 localhost HTTP，且不能包含账号、密码、查询参数或片段");
  }
  if (NODE_ENV === "production") {
    if (!AI_API_KEY) throw new Error("生产环境必须配置 AI_API_KEY");
    if (!AI_MODEL) throw new Error("生产环境必须配置 AI_MODEL");
    if (AUTH_ORIGINS.size === 0 || [...AUTH_ORIGINS].some((origin) => {
      return !isTauriAppOrigin(origin) && /localhost|127\.0\.0\.1/i.test(origin);
    })) {
      throw new Error("生产环境 AUTH_ORIGINS 必须是实际 HTTPS 来源或精确的 Tauri 应用来源，不能使用通配符或本机地址");
    }
    for (const origin of AUTH_ORIGINS) {
      let parsedOrigin;
      try { parsedOrigin = new URL(origin); } catch { throw new Error("生产环境 AUTH_ORIGINS 必须是有效的 HTTPS 来源"); }
      if ((!isTauriAppOrigin(origin) && parsedOrigin.protocol !== "https:") || parsedOrigin.origin !== origin ||
        parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash ||
        parsedOrigin.username || parsedOrigin.password) {
        throw new Error("生产环境 AUTH_ORIGINS 必须是仅含协议、域名和端口的 HTTPS 或 Tauri 应用来源");
      }
    }
  }
}

validateConfig();

fs.mkdirSync(DATA_DIR, { recursive: true });
const MAX_DB_RECORDS = 100_000;
let db = loadDb();
const attempts = new Map();
const failedLogins = new Map();
const activeAiControllers = new Set();
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 5;
const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
const passwordResetCodes = new Map();

function loadDb() {
  const empty = { nextUserId: 1, users: [], sessions: [], codes: [] };
  const candidates = [];
  // A crash after writing the validated temporary file but before rename can
  // otherwise discard the most recent account mutation in favor of an older
  // backup. Only prefer the temp file when it is at least as new as primary.
  try {
    if (fs.existsSync(TEMP_FILE) && (!fs.existsSync(DATA_FILE) ||
      fs.statSync(TEMP_FILE).mtimeMs >= fs.statSync(DATA_FILE).mtimeMs)) {
      candidates.push(TEMP_FILE);
    }
  } catch { /* fall back to the normal primary/backup recovery path */ }
  candidates.push(DATA_FILE, BACKUP_FILE);
  let lastError = null;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const checked = validateDb(parsed);
      if (file === BACKUP_FILE || file === TEMP_FILE) fs.copyFileSync(file, DATA_FILE);
      if (file === TEMP_FILE) {
        // Make the recovered primary newer than a cleanup-resistant temp file
        // on Windows, so a later restart will not replay the same recovery.
        try { fs.utimesSync(DATA_FILE, new Date(), new Date()); } catch { /* best effort */ }
      }
      if (file === BACKUP_FILE) log("error", "Primary account database was invalid; restored backup");
      if (file === TEMP_FILE) log("error", "Primary account database was interrupted; restored temporary data");
      if (file === TEMP_FILE) {
        try { fs.rmSync(TEMP_FILE, { force: true }); }
        catch (error) { log("error", "Unable to remove recovered temporary account database", { message: error?.message }); }
      }
      return checked;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw new Error(`账号库损坏，已停止启动以保护数据：${lastError.message}`);
  return empty;
}

function validateDb(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("账号库根节点格式无效");
  const { users, sessions, codes } = value;
  if (!Array.isArray(users) || !Array.isArray(sessions) || !Array.isArray(codes)) throw new Error("账号库字段格式无效");
  if (users.length > MAX_DB_RECORDS || sessions.length > MAX_DB_RECORDS || codes.length > MAX_DB_RECORDS) {
    throw new Error("账号库记录数量超出限制");
  }
  if (!Number.isSafeInteger(value.nextUserId) || value.nextUserId < 1) throw new Error("账号库 nextUserId 无效");

  const ids = new Set();
  const emails = new Set();
  const phones = new Set();
  const normalizedUsers = users.map((user) => {
    if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("账号记录格式无效");
    if (!Number.isSafeInteger(user.id) || user.id < 1 || ids.has(user.id)) throw new Error("账号 ID 无效或重复");
    ids.add(user.id);
    const emailValue = user.email == null ? "" : String(user.email).trim().toLowerCase();
    const phoneValue = user.phone == null ? "" : String(user.phone).trim();
    const email = emailValue || null;
    const phone = phoneValue || null;
    if (email === null && phone === null) throw new Error("账号缺少登录标识");
    if (email !== null && (email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email) || emails.has(email))) throw new Error("账号邮箱无效或重复");
    if (phone !== null && (phone.length > 32 || !/^\d{6,20}$/.test(phone) || phones.has(phone))) throw new Error("账号手机号无效或重复");
    if (email !== null) emails.add(email);
    if (phone !== null) phones.add(phone);
    for (const field of ["emailVerified", "phoneVerified"]) {
      if (field in user && typeof user[field] !== "boolean") throw new Error(`账号 ${field} 字段无效`);
    }
    if (user.passwordSalt !== undefined && user.passwordSalt !== "" && (typeof user.passwordSalt !== "string" || user.passwordSalt.length < 1 || user.passwordSalt.length > 256)) throw new Error("账号密码盐值无效");
    if (user.passwordHash !== undefined && user.passwordHash !== "" && (typeof user.passwordHash !== "string" || !/^[0-9a-f]{64}$/i.test(user.passwordHash))) throw new Error("账号密码摘要无效");
    if (email !== null && (typeof user.passwordSalt !== "string" || typeof user.passwordHash !== "string")) throw new Error("邮箱账号缺少密码摘要");
    return {
      ...user,
      email,
      phone,
      emailVerified: user.emailVerified ?? false,
      phoneVerified: user.phoneVerified ?? false,
    };
  });
  const maxId = normalizedUsers.reduce((max, user) => Math.max(max, user.id), 0);
  if (value.nextUserId <= maxId) throw new Error("账号库 nextUserId 与账号 ID 冲突");

  const normalizedSessions = sessions.map((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session) ||
      typeof session.tokenHash !== "string" || !/^[0-9a-f]{64}$/i.test(session.tokenHash) ||
      !ids.has(session.userId) || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0 ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt < session.createdAt) {
      throw new Error("会话记录格式无效");
    }
    return session;
  });
  const normalizedCodes = codes.map((code) => {
    if (!code || typeof code !== "object" || Array.isArray(code) || typeof code.target !== "string" ||
      code.target.length > 254 || !/^\d{6}$/.test(String(code.code)) ||
      !Number.isSafeInteger(code.expiresAt) || code.expiresAt < 0 || typeof code.used !== "boolean") {
      throw new Error("验证码记录格式无效");
    }
    return { ...code, target: code.target.trim() };
  });
  return { nextUserId: value.nextUserId, users: normalizedUsers, sessions: normalizedSessions, codes: normalizedCodes };
}

function saveDb() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), "utf8");
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.renameSync(temporary, DATA_FILE);
}

/** Persist a candidate state before exposing it to later requests. If the
 * filesystem rejects the write, restore the exact in-memory snapshot so a
 * failed request cannot create a session or account that vanishes on restart.
 */
function commitDb(next) {
  const previous = db;
  db = next;
  try {
    saveDb();
    return db;
  } catch (error) {
    db = previous;
    // A synchronous write failure is a rejected mutation, not an interrupted
    // process. Do not let startup recovery later promote this failed candidate
    // as if it had been committed; genuine process crashes never reach here and
    // still leave .tmp available for recovery.
    try { fs.rmSync(TEMP_FILE, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function json(res, status, payload) {
  const origin = String(res.req?.headers?.origin || "");
  const allowOrigin = AUTH_ORIGINS.has(origin) || isDevelopmentLoopbackOrigin(origin)
    ? origin
    : "";
  const requestId = String(res.requestId || "");
  const retryAfter = res.getHeader("Retry-After");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After, X-Request-Id",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // The account service only returns JSON. Keep a misrouted response from
    // being interpreted as an executable document by an embedded WebView.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  };
  if (NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  if (requestId) headers["X-Request-Id"] = requestId;
  if (retryAfter) headers["Retry-After"] = retryAfter;
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function limited(res, code, message, retrySeconds = 60) {
  res.setHeader("Retry-After", String(retrySeconds));
  return json(res, 429, fail(code, message, 429).body);
}

function ok(data = {}) { return { ok: true, ...data }; }
function fail(code, message, status = 400) { return { status, body: { ok: false, code, message } }; }

// Node accepts both origin-form ("/healthz") and proxy-style absolute-form
// request targets. This service is an origin server, so only origin-form
// paths are valid. Never use the client-controlled Host header as the URL
// base: malformed Host values used to turn harmless probes into 500s, and an
// absolute URL could be mistaken for a local path.
function requestPath(req) {
  const raw = String(req.url || "");
  if (!raw || raw.length > 8_192 || !raw.startsWith("/")) return null;
  try {
    const parsed = new URL(raw, "http://route-auth.invalid");
    return parsed.origin === "http://route-auth.invalid" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > limit) {
        rejected = true;
        // 继续排空请求流，避免 keep-alive 客户端复用时留下半开连接。
        req.resume();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("response too large");
    error.code = "RESPONSE_TOO_LARGE";
    throw error;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error("response too large");
        error.code = "RESPONSE_TOO_LARGE";
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function normalizePhone(value) { return String(value || "").replace(/[\s\-()]/g, "").replace(/^(\+?86|0086)/, "").replace(/\D/g, ""); }
function hash(value, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, digest: crypto.scryptSync(value, salt, 32).toString("hex") };
}
// 对不存在的账号也执行一次等价的 scrypt，避免通过响应耗时枚举已注册邮箱。
const DUMMY_PASSWORD = hash("route-login-dummy-password", "route-login-dummy-salt");
function verify(value, salt, digest) {
  try {
    const actual = crypto.scryptSync(value, salt, 32).toString("hex");
    const expected = Buffer.from(String(digest), "hex");
    return expected.length === 32 && crypto.timingSafeEqual(Buffer.from(actual, "hex"), expected);
  } catch {
    return false;
  }
}
function token() { return crypto.randomBytes(32).toString("base64url"); }
function userView(user) {
  return { id: user.id, email: user.email ?? null, phone: user.phone ?? null, nickname: user.nickname ?? null, emailVerified: Boolean(user.emailVerified), phoneVerified: Boolean(user.phoneVerified) };
}
function sessionFor(user) {
  const value = token();
  const session = { tokenHash: crypto.createHash("sha256").update(value).digest("hex"), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
  const next = { ...db, sessions: db.sessions.filter((item) => item.expiresAt > Date.now()) };
  next.sessions.push(session);
  const userSessions = next.sessions.filter((item) => item.userId === user.id).sort((a, b) => a.createdAt - b.createdAt);
  while (userSessions.length > MAX_SESSIONS_PER_USER) {
    const expired = userSessions.shift();
    next.sessions = next.sessions.filter((item) => item !== expired);
  }
  commitDb(next);
  return { token: value, user: userView(user), action: "login" };
}
function authUser(req) {
  const raw = String(req.headers.authorization || "");
  if (!raw.startsWith("Bearer ")) return null;
  const tokenHash = crypto.createHash("sha256").update(raw.slice(7)).digest("hex");
  const session = db.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now());
  return session ? db.users.find((item) => item.id === session.userId) || null : null;
}
function validateCredentials(email, password) {
  if (!/^(?:[1-9]\d{4,10}@qq\.com|[A-Za-z0-9][A-Za-z0-9._-]{2,31}@foxmail\.com)$/.test(email)) return "仅支持 QQ 邮箱：数字 QQ 号@qq.com 或别名@foxmail.com";
  if (password.length < 8 || password.length > 32 || /\s/.test(password) || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码需为 8~32 位且同时包含字母和数字";
  return "";
}
function rateLimit(key, windowMs = 60_000, max = 8) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= max) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  return true;
}
function loginLockKey(ip, email) { return `login-lock:${ip}:${email}`; }
function loginLock(key) {
  const record = failedLogins.get(key);
  if (!record) return null;
  if (record.updatedAt && record.updatedAt + LOGIN_LOCK_MS <= Date.now()) {
    failedLogins.delete(key);
    return null;
  }
  if (record.lockedUntil > Date.now()) return record.lockedUntil;
  return null;
}
function recordLoginFailure(key) {
  const current = failedLogins.get(key) || { count: 0, lockedUntil: 0, updatedAt: 0 };
  current.count += 1;
  current.updatedAt = Date.now();
  if (current.count >= LOGIN_FAILURE_LIMIT) current.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  failedLogins.set(key, current);
  return current;
}
function cleanExpired() {
  const now = Date.now();
  const sessions = db.sessions.filter((item) => item.expiresAt > now);
  const codes = db.codes.filter((item) => item.expiresAt > now && !item.used);
  if (sessions.length !== db.sessions.length || codes.length !== db.codes.length) {
    commitDb({ ...db, sessions, codes });
  }
  for (const [key, times] of attempts) {
    const recent = times.filter((time) => now - time < 60_000);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
  }
  for (const [key, record] of failedLogins) {
    if ((record.updatedAt || 0) + LOGIN_LOCK_MS <= now) failedLogins.delete(key);
  }
  for (const [email, record] of passwordResetCodes) {
    if (record.expiresAt <= now || record.used) passwordResetCodes.delete(email);
  }
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function requestAiContent(req, res, system, userPrompt) {
  const controller = new AbortController();
  activeAiControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 90_000);
  const abortIfClientLeaves = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abortIfClientLeaves);
  res.once("close", abortIfClientLeaves);
  try {
    const response = await fetch(AI_ENDPOINT, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(userPrompt) }], temperature: 0.4 }),
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error("AI 服务不应返回重定向，请检查接口地址");
      error.code = "AI_REDIRECT";
      throw error;
    }
    let responseText;
    try {
      responseText = await readLimitedText(response, MAX_AI_RESPONSE);
    } catch (error) {
      if (error?.code === "RESPONSE_TOO_LARGE") {
        const large = new Error("AI 服务返回内容过大");
        large.code = "AI_BAD_RESPONSE";
        throw large;
      }
      throw error;
    }
    let payload;
    try { payload = responseText ? JSON.parse(responseText) : {}; } catch {
      const invalid = new Error("AI 服务返回的不是有效 JSON");
      invalid.code = "AI_BAD_RESPONSE";
      throw invalid;
    }
    if (!response.ok) {
      const upstream = new Error(String(payload?.error?.message || "AI 服务请求失败").slice(0, 180));
      upstream.code = "AI_UPSTREAM";
      throw upstream;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const empty = new Error("AI 服务未返回有效内容");
      empty.code = "AI_BAD_RESPONSE";
      throw empty;
    }
    return content;
  } finally {
    clearTimeout(timer);
    activeAiControllers.delete(controller);
    req.removeListener("aborted", abortIfClientLeaves);
    res.removeListener("close", abortIfClientLeaves);
  }
}

function parseAgentJson(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(text); } catch (firstError) {
    // Some compatible chat endpoints add one sentence before/after the JSON
    // despite the system instruction. Recover only a complete outer object;
    // schema validation below remains the permission boundary.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw firstError;
  }
}

function agentValidationSummary(error) {
  if (!error || typeof error !== "object") return "unknown";
  if (Array.isArray(error.issues)) {
    return error.issues.slice(0, 3).map((item) => `${Array.isArray(item.path) ? item.path.join(".") : "proposal"}:${String(item.code || "invalid")}`).join(",").slice(0, 240);
  }
  return String(error.message || "invalid").slice(0, 160);
}

function aiFailure(error) {
  if (error?.code === "AI_REDIRECT") return { status: 502, code: "AI_REDIRECT", message: error.message };
  if (error?.code === "AI_BAD_RESPONSE") return { status: 502, code: "AI_BAD_RESPONSE", message: error.message };
  if (error?.code === "AI_UPSTREAM") return { status: 502, code: "AI_UPSTREAM", message: error.message };
  return { status: 502, code: "AI_NETWORK", message: error?.name === "AbortError" ? "AI 服务响应超时" : "AI 服务暂时不可用" };
}

async function route(req, res) {
  const pathName = requestPath(req);
  if (!pathName) return json(res, 400, fail("BAD_REQUEST_TARGET", "请求目标无效", 400).body);
  if (req.method === "OPTIONS") return json(res, 204, {});
  const isWrite = req.method === "POST";
  const bodyLimit = pathName === "/api/ai/agent" ? MAX_AGENT_BODY : MAX_BODY;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (isWrite && !contentType.startsWith("application/json")) {
    return json(res, 415, fail("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415).body);
  }
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    // Drain an already-started oversized request before replying. Without
    // this, unread bytes can remain on a keep-alive socket and be interpreted
    // as the next request, producing intermittent parse failures for clients
    // that reuse the connection.
    req.resume();
    return json(res, 413, fail("BODY_TOO_LARGE", "请求内容过大", 413).body);
  }
  cleanExpired();
  let body = {};
  if (isWrite) {
    try {
      body = await readBody(req, bodyLimit);
    } catch (error) {
      if (error?.message === "request too large") return json(res, 413, fail("BODY_TOO_LARGE", "请求内容过大", 413).body);
      return json(res, 400, fail("BAD_JSON", error.message, 400).body);
    }
    // JSON null、数组和字符串都不是接口请求对象，统一按空对象处理，
    // 让后续校验返回 400，而不是因访问属性触发 500。
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  }
  const ip = req.socket.remoteAddress || "unknown";
  if (req.method === "GET" && pathName === "/healthz") {
    return json(res, 200, ok({ service: "route-auth", aiConfigured: Boolean(AI_API_KEY) }));
  }
  if (req.method === "GET" && pathName === "/livez") {
    return json(res, 200, ok({ service: "route-auth", live: true }));
  }
  if (req.method === "GET" && pathName === "/readyz") {
    const ready = NODE_ENV !== "production" || Boolean(AI_API_KEY);
    return json(res, ready ? 200 : 503, ready
      ? ok({ service: "route-auth", ready: true })
      : fail("NOT_READY", "生产环境尚未配置 AI 服务", 503).body);
  }
  if (req.method === "POST" && pathName === "/api/auth/code/send") {
    return json(res, 410, fail("SMS_DISABLED", "短信登录暂未开放，请使用 QQ 邮箱和密码登录", 410).body);
    /*
    const target = body.channel === "sms" ? normalizePhone(body.target) : normalizeEmail(body.target);
    if (!rateLimit(`code:${ip}:${target}`, 60_000, 3)) return json(res, 429, fail("RATE_LIMITED", "请求过于频繁，请稍后再试", 429).body);
    if (!/^1[3-9]\d{9}$/.test(target)) return json(res, 400, fail("INVALID_PHONE", "手机号格式不正确").body);
    const value = String(Math.floor(100000 + Math.random() * 900000));
    db.codes = db.codes.filter((item) => item.target !== target);
    db.codes.push({ target, code: value, expiresAt: Date.now() + CODE_TTL_MS, used: false }); saveDb();
    return json(res, 200, ok({ target, expiresIn: 300, devCode: value }));
    */
  }
  if (req.method === "POST" && pathName === "/api/auth/email/register") {
    const email = normalizeEmail(body.email); const password = String(body.password || ""); const error = validateCredentials(email, password);
    if (error) return json(res, 400, fail("INVALID_INPUT", error).body);
    if (!rateLimit(`register:${ip}`, 60_000, 5)) return limited(res, "RATE_LIMITED", "请求过于频繁，请稍后再试");
    if (db.users.some((user) => user.email === email)) return json(res, 409, fail("EMAIL_TAKEN", "该邮箱已注册").body);
    const secured = hash(password); const user = { id: db.nextUserId, email, phone: null, nickname: null, emailVerified: false, phoneVerified: false, passwordSalt: secured.salt, passwordHash: secured.digest };
    const previous = db;
    try {
      db = { ...db, nextUserId: db.nextUserId + 1, users: [...db.users, user] };
      const session = sessionFor(user);
      session.action = "registered";
      return json(res, 200, ok(session));
    } catch (error) {
      db = previous;
      throw error;
    }
  }
  if (req.method === "POST" && pathName === "/api/auth/email/login") {
    const email = normalizeEmail(body.email); const password = String(body.password || "");
    const inputError = validateCredentials(email, password);
    if (inputError) return json(res, 400, fail("INVALID_INPUT", inputError).body);
    const user = db.users.find((item) => item.email === email);
    const lockKey = loginLockKey(ip, email);
    const lockedUntil = loginLock(lockKey);
    if (lockedUntil) return limited(res, "LOGIN_LOCKED", "登录失败次数过多，请 15 分钟后再试", 900);
    if (!rateLimit(`login:${ip}:${email}`, 60_000, 8)) return limited(res, "RATE_LIMITED", "登录尝试过于频繁，请一分钟后再试");
    const validPassword = user?.passwordHash
      ? verify(password, user.passwordSalt, user.passwordHash)
      : verify(password, DUMMY_PASSWORD.salt, DUMMY_PASSWORD.digest);
    if (!user || !validPassword) {
      const failure = recordLoginFailure(lockKey);
      if (failure.lockedUntil) return limited(res, "LOGIN_LOCKED", "登录失败次数过多，请 15 分钟后再试", 900);
      return json(res, 401, fail("BAD_CREDENTIALS", "邮箱或密码不正确", 401).body);
    }
    failedLogins.delete(lockKey);
    return json(res, 200, ok(sessionFor(user)));
  }
  if (req.method === "POST" && pathName === "/api/auth/password/reset/send") {
    const email = normalizeEmail(body.email);
    const inputError = validateCredentials(email, "ResetPass123");
    if (inputError && !/^密码/.test(inputError)) return json(res, 400, fail("INVALID_INPUT", "QQ 邮箱格式不正确").body);
    if (NODE_ENV === "production") return json(res, 503, fail("PASSWORD_RESET_NOT_CONFIGURED", "生产环境尚未配置邮件验证服务，请联系管理员", 503).body);
    if (!rateLimit(`password-reset:${ip}:${email}`, 60_000, 3)) return limited(res, "RATE_LIMITED", "请求过于频繁，请稍后再试");
    const user = db.users.find((item) => item.email === email);
    const record = user ? { code: String(Math.floor(100000 + Math.random() * 900000)), expiresAt: Date.now() + PASSWORD_RESET_TTL_MS, used: false } : null;
    if (record) passwordResetCodes.set(email, record);
    const payload = { email, expiresIn: Math.floor(PASSWORD_RESET_TTL_MS / 1000) };
    // devCode is intentionally limited to non-production local development;
    // a deployed service must send the code through a configured mail provider.
    if (record) payload.devCode = record.code;
    return json(res, 200, ok(payload));
  }
  if (req.method === "POST" && pathName === "/api/auth/password/reset") {
    const email = normalizeEmail(body.email);
    const code = String(body.code || "");
    const password = String(body.password || "");
    const inputError = validateCredentials(email, password);
    if (inputError) return json(res, 400, fail("INVALID_INPUT", inputError).body);
    if (!/^\d{6}$/.test(code)) return json(res, 400, fail("CODE_INVALID", "验证码应为 6 位数字").body);
    if (!rateLimit(`password-reset-submit:${ip}:${email}`, 60_000, 8)) return limited(res, "RATE_LIMITED", "尝试过于频繁，请稍后再试");
    const record = passwordResetCodes.get(email);
    const user = db.users.find((item) => item.email === email);
    if (!record || record.used || record.expiresAt <= Date.now() || record.code !== code || !user) {
      return json(res, 401, fail("CODE_INVALID", "验证码错误或已过期", 401).body);
    }
    const secured = hash(password);
    const nextUsers = db.users.map((item) => item.id === user.id
      ? { ...item, passwordSalt: secured.salt, passwordHash: secured.digest }
      : item);
    // Resetting a password revokes all existing sessions, including a stolen
    // token, and requires a fresh login on every device.
    commitDb({ ...db, users: nextUsers, sessions: db.sessions.filter((item) => item.userId !== user.id) });
    record.used = true;
    passwordResetCodes.delete(email);
    return json(res, 200, ok({ action: "password_reset" }));
  }
  if (req.method === "POST" && pathName === "/api/auth/code/login") {
    return json(res, 410, fail("SMS_DISABLED", "短信登录暂未开放，请使用 QQ 邮箱和密码登录", 410).body);
    /*
    const target = normalizePhone(body.target); const record = db.codes.find((item) => item.target === target && !item.used && item.expiresAt > Date.now());
    if (!record || record.code !== String(body.code || "")) return json(res, 401, fail("CODE_INVALID", "验证码错误或已过期", 401).body);
    record.used = true; let user = db.users.find((item) => item.phone === target);
    if (!user) { user = { id: db.nextUserId++, email: null, phone: target, nickname: null, emailVerified: false, phoneVerified: true }; db.users.push(user); }
    saveDb(); return json(res, 200, ok(sessionFor(user)));
    */
  }
  if (req.method === "GET" && pathName === "/api/me") {
    const user = authUser(req); if (!user) return json(res, 401, fail("UNAUTHORIZED", "登录已失效，请重新登录", 401).body); return json(res, 200, ok({ user: userView(user) }));
  }
  if (req.method === "POST" && pathName === "/api/auth/logout") {
    const user = authUser(req);
    if (!user) return json(res, 401, fail("UNAUTHORIZED", "登录已失效，请重新登录", 401).body);
    const raw = String(req.headers.authorization || ""); const tokenHash = crypto.createHash("sha256").update(raw.replace(/^Bearer /, "")).digest("hex");
    commitDb({ ...db, sessions: db.sessions.filter((item) => item.tokenHash !== tokenHash) });
    return json(res, 200, ok({ action: "logged_out" }));
  }
  if (req.method === "POST" && pathName === "/api/ai/agent") {
    const user = authUser(req);
    if (!user) return json(res, 401, fail("UNAUTHORIZED", "请先登录账号", 401).body);
    if (!AI_API_KEY) return json(res, 503, fail("AI_NOT_CONFIGURED", "AI 深度分析尚未配置，本地行程管家仍可使用", 503).body);
    const checked = agentContextSchema.safeParse(body.request);
    if (!checked.success) return json(res, 400, fail("INVALID_INPUT", "行程管家参数无效或内容过多").body);
    if (!rateLimit(`agent:${user.id}`, 60_000, 4)) return limited(res, "RATE_LIMITED", "管家请求过于频繁，请一分钟后再试");
    try {
      const content = await requestAiContent(req, res, AGENT_SYSTEM_PROMPT, checked.data);
      let proposal;
      try { proposal = validateAgentProposal(parseAgentJson(content), checked.data); }
      catch (error) {
        log("warn", "AI agent proposal rejected", { reason: agentValidationSummary(error) });
        return json(res, 502, fail("AI_BAD_RESPONSE", "AI 提案格式或动作不符合安全规则，请重新分析", 502).body);
      }
      return json(res, 200, ok({ content: JSON.stringify(proposal) }));
    } catch (error) {
      const failure = aiFailure(error);
      return json(res, failure.status, fail(failure.code, failure.message, failure.status).body);
    }
  }
  if (req.method === "POST" && pathName === "/api/ai/generate") {
    const user = authUser(req);
    if (!user) return json(res, 401, fail("UNAUTHORIZED", "请先登录账号", 401).body);
    if (!AI_API_KEY) return json(res, 503, fail("AI_NOT_CONFIGURED", "AI 服务尚未配置，请联系管理员", 503).body);
    const request = body?.request;
    const validPaces = new Set(["轻松", "适中", "充实"]);
    if (!request || typeof request.destination !== "string" || request.destination.trim().length < 1 || request.destination.length > 120 ||
      !Number.isInteger(request.days) || request.days < 1 || request.days > 14 ||
      !Number.isInteger(request.travelers) || request.travelers < 1 || request.travelers > 20 ||
      typeof request.budget !== "number" || !Number.isFinite(request.budget) || request.budget < 0 || request.budget > 10_000_000 ||
      typeof request.startDate !== "string" || !isCalendarDate(request.startDate) ||
      !validPaces.has(request.pace) ||
      !Array.isArray(request.interests) || request.interests.length > 20 || request.interests.some((item) => typeof item !== "string" || item.trim().length < 1 || item.length > 40) ||
      typeof request.notes !== "string" || request.notes.length > 2_000) {
      return json(res, 400, fail("INVALID_INPUT", "行程参数无效").body);
    }
    if (!rateLimit(`ai:${user.id}`, 60_000, 4)) return limited(res, "RATE_LIMITED", "AI 请求过于频繁，请一分钟后再试");
    const system = `你是一位审慎的中文旅行规划助手。只返回一个 JSON 对象，不要 Markdown 或额外文字。JSON 格式必须为：{"title":"标题","destination":"目的地","overview":"简述","days":[{"date":"YYYY-MM-DD","theme":"当日主题","activities":[{"time":"HH:MM","title":"活动","detail":"实际安排与提醒","location":"可搜索的地点","estimatedCost":0,"durationMinutes":60,"type":"类别"}]}],"tips":["提示"]}。days 数量必须等于旅行天数，日期从出发日期逐日递增。estimatedCost 是所有同行者合计费用，只能是数字。总费用不得超过 totalBudgetCny；预算不足主动降低标准。不要编造实时营业时间、票价、天气、预约余量或链接。`;
    const userPrompt = { ...request, totalBudgetCny: request.budget, perPersonBudgetCny: request.travelers > 0 ? Math.round(request.budget / request.travelers * 100) / 100 : request.budget };
    const controller = new AbortController();
    activeAiControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 90_000);
    const abortIfClientLeaves = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", abortIfClientLeaves);
    res.once("close", abortIfClientLeaves);
    try {
      const response = await fetch(AI_ENDPOINT, {
        method: "POST",
        // The upstream request carries AI_API_KEY. A redirect could otherwise
        // send that credential to a different host or downgrade to HTTP.
        redirect: "manual",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(userPrompt) }], temperature: 0.6 }),
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return json(res, 502, fail("AI_REDIRECT", "AI 服务不应返回重定向，请检查接口地址", 502).body);
      }
      let responseText;
      try {
        responseText = await readLimitedText(response, MAX_AI_RESPONSE);
      } catch (error) {
        if (error?.code === "RESPONSE_TOO_LARGE") return json(res, 502, fail("AI_BAD_RESPONSE", "AI 服务返回内容过大", 502).body);
        throw error;
      }
      let payload;
      try { payload = responseText ? JSON.parse(responseText) : {}; } catch {
        return json(res, 502, fail("AI_BAD_RESPONSE", "AI 服务返回的不是有效 JSON", 502).body);
      }
      if (!response.ok) {
        const message = String(payload?.error?.message || "AI 服务请求失败").slice(0, 180);
        return json(res, 502, fail("AI_UPSTREAM", message, 502).body);
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) return json(res, 502, fail("AI_BAD_RESPONSE", "AI 服务未返回有效行程", 502).body);
      return json(res, 200, ok({ content }));
    } catch (error) {
      return json(res, 502, fail("AI_NETWORK", error?.name === "AbortError" ? "AI 服务响应超时" : "AI 服务暂时不可用", 502).body);
    } finally {
      clearTimeout(timer);
      activeAiControllers.delete(controller);
      req.removeListener("aborted", abortIfClientLeaves);
      res.removeListener("close", abortIfClientLeaves);
    }
  }
  return json(res, 404, fail("NOT_FOUND", "接口不存在", 404).body);
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.requestId = crypto.randomUUID();
  res.once("finish", () => {
    const pathName = requestPath(req) || "<invalid>";
    log("info", "request", { requestId: res.requestId, method: req.method, path: pathName, status: res.statusCode, durationMs: Date.now() - startedAt, origin: req.headers.origin || undefined });
  });
  route(req, res).catch((error) => {
    log("error", "Unhandled request error", { requestId: res.requestId, message: error?.message });
    if (!res.headersSent && !res.writableEnded) json(res, 500, fail("SERVER_ERROR", "账号服务内部错误", 500).body);
  });
});
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 10_000;
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    log("error", `账号服务端口 ${PORT} 已被占用，请停止旧进程或设置 AUTH_PORT`);
  } else {
    log("error", "账号服务启动失败", { code: error?.code });
  }
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  log("info", `Route auth service listening on http://${HOST}:${PORT}`);
});
// Expiry cleanup is best-effort maintenance. A transient disk-full or
// permission error must be logged and retried on the next interval instead of
// becoming an uncaught timer exception that terminates the auth service.
function runCleanupSafely() {
  try {
    cleanExpired();
  } catch (error) {
    log("error", "Unable to persist expired account cleanup; will retry", {
      message: error?.message,
    });
  }
}
const cleanupTimer = setInterval(runCleanupSafely, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
function shutdown(signal) {
  log("info", `Received ${signal}, stopping auth service`);
  clearInterval(cleanupTimer);
  for (const controller of activeAiControllers) controller.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
