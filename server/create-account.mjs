#!/usr/bin/env node
/**
 * 单人私人版的账号创建工具。
 *
 * 为什么需要它
 * - 正式部署已关闭公开注册（AUTH_ALLOW_PUBLIC_SIGNUP 默认 false），
 *   而单人版又需要一个账号用于「可选」的服务端 AI / 多设备会话。
 * - 这个脚本让部署方**在本机**直接写入 accounts.json，走的是服务端同一套
 *   scrypt 参数、同一套库结构校验，不引入第二个密码哈希实现。
 *
 * 用法
 *   node server/create-account.mjs --email 123456789@qq.com --password 'Abc12345'
 *   node server/create-account.mjs --email xxx@qq.com --password '...' --nickname 小明
 *   node server/create-account.mjs --email xxx@qq.com --rotate      # 改密码
 *   node server/create-account.mjs --list
 *   node server/create-account.mjs --email xxx@qq.com --delete
 *
 * 环境变量与服务端一致：AUTH_DATA_DIR 决定账号库位置。
 * 改动前会自动把现有库备份为 accounts.json.bak（服务端启动时也会用它做恢复）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.AUTH_DATA_DIR || path.join(HERE, "data"));
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const BACKUP_FILE = `${DATA_FILE}.bak`;
const TEMP_FILE = `${DATA_FILE}.tmp`;

const QQ_EMAIL_RE = /^(?:[1-9]\d{4,10}@qq\.com|[A-Za-z0-9][A-Za-z0-9._-]{2,31}@foxmail\.com)$/;

function die(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; }
    else { out[key] = next; i += 1; }
  }
  return out;
}

function readDb() {
  if (!fs.existsSync(DATA_FILE)) {
    return { nextUserId: 1, users: [], sessions: [], codes: [] };
  }
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.users)) {
    die(`账号库结构异常，已停止写入：${DATA_FILE}`);
  }
  return {
    nextUserId: Number.isSafeInteger(parsed.nextUserId) && parsed.nextUserId > 0 ? parsed.nextUserId : 1,
    users: parsed.users,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    codes: Array.isArray(parsed.codes) ? parsed.codes : [],
  };
}

/** 原子写：先写临时文件并落盘，再改名覆盖；旧库先复制为 .bak。 */
function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  const payload = JSON.stringify(db, null, 2);
  const fd = fs.openSync(TEMP_FILE, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 32).toString("hex") };
}

function checkPassword(password) {
  if (password.length < 8 || password.length > 32) return "密码需为 8~32 位";
  if (/\s/.test(password)) return "密码不能包含空格";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码需同时包含字母和数字";
  return "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

const args = parseArgs(process.argv.slice(2));
const db = readDb();

if (args.list) {
  if (!db.users.length) {
    process.stdout.write("账号库为空。\n");
  } else {
    process.stdout.write(`账号库：${DATA_FILE}\n`);
    for (const user of db.users) {
      process.stdout.write(`  id=${user.id}  email=${user.email ?? "-"}  phone=${user.phone ?? "-"}  nickname=${user.nickname ?? "-"}\n`);
    }
  }
  process.exit(0);
}

const email = normalizeEmail(args.email);
if (!email) die("需要 --email（或使用 --list 查看现有账号）");
if (!QQ_EMAIL_RE.test(email)) die("仅支持 QQ 邮箱：数字 QQ 号@qq.com 或 别名@foxmail.com");

const existingIndex = db.users.findIndex((user) => normalizeEmail(user.email) === email);

if (args.delete) {
  if (existingIndex < 0) die(`账号不存在：${email}`);
  const userId = db.users[existingIndex].id;
  db.users = db.users.filter((_, index) => index !== existingIndex);
  db.sessions = db.sessions.filter((session) => session.userId !== userId);
  writeDb(db);
  process.stdout.write(`已删除账号 ${email}（并吊销其全部会话）。\n`);
  process.exit(0);
}

const password = typeof args.password === "string" ? args.password : "";
if (!password) die("需要 --password（密码不会写入日志，只存 scrypt 摘要）");
const passwordError = checkPassword(password);
if (passwordError) die(passwordError);

const secured = hashPassword(password);
if (existingIndex >= 0) {
  if (!args.rotate) {
    die(`账号已存在：${email}。如需修改密码请加 --rotate`);
  }
  const target = db.users[existingIndex];
  db.users[existingIndex] = { ...target, ...secured, emailVerified: true };
  // 改密码即吊销旧会话：设备丢失或口令泄露时的第一道止损。
  db.sessions = db.sessions.filter((session) => session.userId !== target.id);
  writeDb(db);
  process.stdout.write(`已更新密码并吊销旧会话：${email}\n`);
  process.exit(0);
}

if (args.rotate) die(`--rotate 需要账号已存在：${email}`);

const nickname = typeof args.nickname === "string" ? args.nickname.slice(0, 80) : null;
const user = {
  id: db.nextUserId,
  email,
  phone: null,
  nickname,
  emailVerified: true,
  phoneVerified: false,
  ...secured,
};
db.users.push(user);
db.nextUserId = db.nextUserId + 1;
writeDb(db);
process.stdout.write(`已创建账号：${email}（id=${user.id}）\n`);
process.stdout.write(`账号库：${DATA_FILE}\n`);
process.stdout.write(`备份：${BACKUP_FILE}\n`);
