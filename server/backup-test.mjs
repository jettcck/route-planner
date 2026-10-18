/**
 * `.routebackup` 备份格式的回归测试。
 *
 * 覆盖
 *  1. 明文包 checksum 覆盖 data，任何一位改动都会被抓到
 *  2. 加密包：正确口令可解、错误口令报错、篡改密文报错、口令不入包
 *  3. buildBackupData 只打包请求的数据段
 *  4. summarizeBackup 给出天数/活动数
 *  5. 快照轮转只保留 MAX_SNAPSHOTS 个
 *
 * 前端模块用 TypeScript 源码 + transpileModule 直接加载，
 * 与 storage-key-test.mjs 保持同一套测试手法。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// WebCrypto / btoa 在 Node 18+ 全局可用；localStorage 需要垫片。
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

async function loadModule(path, stubSource = "") {
  const source = fs.readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  // 把 `from "./store"` 换成一个内联的 data: 模块，避免额外落盘
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  const rewritten = compiled.replace(/"\.\/store"/g, JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`);
}

const stub = `
function loadJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
export function loadStored(key, fallback, sanitize) {
  const value = loadJson(key, fallback);
  if (sanitize) { const checked = sanitize(value); return checked === null || checked === undefined ? fallback : checked; }
  return value;
}
export function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
`;
const backup = await loadModule("src/features/backup.ts", stub);

const sampleData = {
  trip: { destination: "杭州", days: [{ date: "2026-10-10", activities: [{ title: "西湖" }, { title: "灵隐寺" }] }] },
  input: { destination: "杭州", days: 2 },
  expenses: [{ id: "a", title: "门票", amount: 80 }],
  checkIns: { "西湖": { at: 1 } },
  prepState: { "todo:1": true },
  packing: [{ id: "p1", title: "护照" }],
};
const meta = { appVersion: "0.3.9", source: "android", sections: backup.ALL_SECTIONS };
const payload = { ...backup.buildBackupData({ ...sampleData, plannerInput: sampleData.input, packing: sampleData.packing }), trip: sampleData.trip };

// ------------------------------------------------------------------ 明文包
const plainData = payload.data;
const checksum = await backup.sha256Hex(
  // stableStringify 未导出，用同样的稳定序列化在测试侧重建
  stable(plainData),
);
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

const plainFile = {
  format: backup.BACKUP_FORMAT_ID,
  encrypted: false,
  schemaVersion: backup.BACKUP_SCHEMA_VERSION,
  appVersion: "0.3.9",
  createdAt: new Date().toISOString(),
  source: "android",
  sections: payload.sections,
  data: plainData,
  checksum,
};

const parsedPlain = await backup.parseBackupFile(JSON.stringify(plainFile));
assert.equal(parsedPlain.needsPassphrase, false, "明文包不应要求口令");
assert.deepEqual(parsedPlain.data, plainData, "明文包应还原原始数据");

// 篡改一个字节必须被发现
const tampered = { ...plainFile, data: { ...plainData, expenses: [] } };
await assert.rejects(
  () => backup.parseBackupFile(JSON.stringify(tampered)),
  /校验失败/,
  "被修改的明文包必须校验失败",
);

// 伪造 format 的普通 JSON 必须被拒绝
await assert.rejects(() => backup.parseBackupFile(JSON.stringify({ hello: "world" })), /不是途迹/);

// 缺少 checksum 必须被拒绝
const noChecksum = { ...plainFile };
delete noChecksum.checksum;
await assert.rejects(() => backup.parseBackupFile(JSON.stringify(noChecksum)), /校验值/);

// ------------------------------------------------------------------ 加密包
const PASS = "MyRoutePass2026";
const encrypted = await backup.encryptBackup(meta, plainData, PASS);
const encryptedFile = { ...encrypted, format: backup.BACKUP_FORMAT_ID, encrypted: true };

assert.equal(JSON.stringify(encryptedFile).includes(PASS), false, "口令绝不能写入备份文件");
assert.equal(JSON.stringify(encryptedFile).includes("杭州"), false, "密文不应泄露明文内容");
assert.ok(encryptedFile.encryption.iterations >= 100_000, "PBKDF2 迭代次数过低");

const noPass = await backup.parseBackupFile(JSON.stringify(encryptedFile));
assert.equal(noPass.needsPassphrase, true, "加密包应先要求口令");

const decrypted = await backup.parseBackupFile(JSON.stringify(encryptedFile), PASS);
assert.deepEqual(decrypted.data, plainData, "正确口令应解出完全一致的数据");

await assert.rejects(
  () => backup.parseBackupFile(JSON.stringify(encryptedFile), "WrongPass2026"),
  /口令错误/,
  "错误口令必须失败",
);

// 篡改密文中的一个 base64 字符
const bytes = Buffer.from(encryptedFile.ciphertext, "base64");
bytes[0] ^= 0xff;
const corrupt = { ...encryptedFile, ciphertext: bytes.toString("base64") };
await assert.rejects(
  () => backup.parseBackupFile(JSON.stringify(corrupt), PASS),
  /口令错误|损坏/,
  "被篡改的密文必须失败",
);

// 迭代次数异常（防止降级攻击）必须拒绝
const weak = { ...encryptedFile, encryption: { ...encryptedFile.encryption, iterations: 1000 } };
await assert.rejects(() => backup.parseBackupFile(JSON.stringify(weak), PASS), /迭代次数异常|加密参数异常/);

// ------------------------------------------------------------------ 只打包请求的段
const partial = backup.buildBackupData({
  trip: sampleData.trip,
  plannerInput: sampleData.input,
  weather: undefined,
  expenses: sampleData.expenses,
  checkIns: undefined,
  prepState: undefined,
  packing: sampleData.packing,
  sections: ["trip", "expenses"],
});
assert.deepEqual(partial.sections, ["trip", "expenses"], "只应打包请求的数据段");
assert.equal("packing" in partial.data, false, "未请求的段不应出现在包内");

// ------------------------------------------------------------------ 概要
const summary = backup.summarizeBackup({ ...encryptedFile, createdAt: "2026-10-10T00:00:00.000Z" }, plainData, true);
const days = summary.counts.find((item) => item.label === "行程天数");
const activities = summary.counts.find((item) => item.label === "活动条目");
assert.equal(days?.count, 1, "应统计行程天数");
assert.equal(activities?.count, 2, "应统计活动条目数");
assert.equal(summary.encrypted, true, "概要应标记加密状态");

// ------------------------------------------------------------------ 快照轮转
const metaBase = { appVersion: "0.3.9", sections: ["trip"], counts: [] };
const ids = [];
for (let index = 0; index < backup.MAX_SNAPSHOTS + 3; index += 1) {
  const id = backup.newSnapshotId();
  ids.push(id);
  const ok = backup.writeSnapshot({ ...metaBase, id, createdAt: new Date(Date.now() + index).toISOString() },
    { schemaVersion: backup.BACKUP_SCHEMA_VERSION, appVersion: "0.3.9", createdAt: new Date().toISOString(), sections: ["trip"], data: { trip: sampleData.trip } });
  assert.equal(ok, true, `第 ${index + 1} 个快照应写入成功`);
  // 同一毫秒内生成的 id 必须唯一
  await new Promise((resolve) => setTimeout(resolve, 2));
}
const kept = backup.listSnapshots();
assert.equal(kept.length, backup.MAX_SNAPSHOTS, `快照应只保留 ${backup.MAX_SNAPSHOTS} 个`);
assert.equal(new Set(ids).size, ids.length, "快照 id 必须唯一");
assert.equal(backup.readSnapshot(kept[0].id) !== null, true, "最新快照必须可读");
// 最旧的快照体应已被清理
const dropped = ids[0];
assert.equal(backup.readSnapshot(dropped), null, "超出保留数量的旧快照体应被删除");

// 删除
assert.equal(backup.deleteSnapshot(kept[0].id), true, "删除快照应成功");
assert.equal(backup.listSnapshots().length, backup.MAX_SNAPSHOTS - 1, "删除后数量应减一");

// 文件名
const name = backup.backupFileName("杭州 / 西湖");
assert.match(name, /\.routebackup$/, "文件名应使用 .routebackup 扩展名");
assert.equal(name.includes("/"), false, "文件名不能包含路径分隔符");

// 导入用的 <input accept> 不得包含自定义扩展名。
// Android DocumentsUI 会把 accept 里的扩展名换算成 MIME，`.routebackup` 没有
// 对应 MIME，结果文件在选择器里是 enabled="false" 的灰项——用户点不动，
// 表现为"导入功能坏了"。备份文件本质是 JSON，用 MIME 即可选中。
const viewSource = fs.readFileSync("src/features/backup-view.tsx", "utf8");
const acceptMatch = viewSource.match(/accept=(?:"([^"]*)"|\{`([^`]*)`\})/);
assert.ok(acceptMatch, "backup-view 应显式声明 accept");
const acceptValue = acceptMatch[1] ?? acceptMatch[2];
assert.equal(
  /\.routebackup/.test(acceptValue.replace(/\$\{[^}]*\}/g, "")),
  false,
  "accept 不能写死 .routebackup 扩展名，否则 Android 选择器会把文件置灰",
);
assert.match(acceptValue, /application\/json/, "accept 至少应包含 application\/json");

process.stdout.write("routebackup 格式测试通过：校验、加密、篡改检测、快照轮转、accept 约束均符合预期\n");
