/**
 * 生成一份真实的 .routebackup 样本（加密），用于真机/模拟器导入验证。
 *
 * 与 backup-test.mjs 共用同一套「TypeScript 源码直接加载」手法，
 * 保证产出的文件与 App 内导出的文件结构完全一致。
 *
 * 用法：node server/make-backup-sample.mjs <输出路径> [口令]
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

async function loadModule(sourcePath, stubSource = "") {
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
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

const outPath = process.argv[2];
const passphrase = process.argv[3] || "";
if (!outPath) {
  console.error("usage: node server/make-backup-sample.mjs <out.routebackup> [passphrase]");
  process.exit(2);
}

const backup = await loadModule("src/features/backup.ts", stub);

// 与模拟器上原本的数据风格一致（九寨沟 5 天 6 人 6000 预算），便于肉眼核对恢复结果。
// 与 App 内 TripPlan 的真实结构对齐（见 src/features/schema 与内置示例）：
// { title, destination, overview, days[{date, theme, activities[{time,title,detail,location,estimatedCost,durationMinutes,type}]}], tips, sample }
const trip = {
  title: "九寨沟 · 山水五日",
  destination: "九寨沟",
  overview: "以九寨沟风景区为核心，前松后紧，留出一天缓冲应对山区天气变化。",
  days: [
    {
      date: "2026-10-06",
      theme: "成都出发与沟口落脚",
      activities: [
        { time: "08:00", title: "成都出发乘长途大巴前往九寨沟", detail: "茶店子客运站发车，全程约 8 小时，中途停靠休息。", location: "成都茶店子客运站", estimatedCost: 180, durationMinutes: 480, type: "交通" },
        { time: "17:00", title: "入住九寨沟沟口经济型客栈", detail: "选沟口附近，次日步行进景区。", location: "九寨沟沟口", estimatedCost: 400, durationMinutes: 60, type: "住宿" },
        { time: "18:30", title: "藏式简餐晚餐", detail: "沟口餐馆集中，人均约 70 元。", location: "九寨沟沟口", estimatedCost: 70, durationMinutes: 90, type: "餐饮" },
      ],
    },
    {
      date: "2026-10-07",
      theme: "九寨沟主景区",
      activities: [
        { time: "07:00", title: "早餐后前往九寨沟景区", detail: "提前在线预约门票与观光车。", location: "九寨沟景区沟口", estimatedCost: 260, durationMinutes: 60, type: "门票" },
        { time: "09:00", title: "日则沟精华段", detail: "五花海、珍珠滩瀑布一线，按观光车调度安排顺序。", location: "日则沟", estimatedCost: 0, durationMinutes: 240, type: "自然" },
        { time: "18:00", title: "返回沟口休息", detail: "山区天黑早，预留返程时间。", location: "九寨沟沟口", estimatedCost: 0, durationMinutes: 40, type: "交通" },
      ],
    },
  ],
  tips: ["山区昼夜温差大，备冲锋衣", "门票需实名预约，提前 1–3 天确认", "海拔约 2000–3000 米，注意节奏"],
  sample: false,
};
const plannerInput = { destination: "九寨沟", startDate: "2026-10-06", days: 2, travelers: 6, budget: 6000, pace: "轻松", interests: ["自然", "人文"], notes: "" };
// Expense：id/date/category/title/amount/currency/rate/paidBy/shares(+participants)
const expenses = [
  { id: "e1", date: "2026-10-06", category: "交通", title: "长途大巴 6 人", amount: 1080, currency: "CNY", rate: 1, paidBy: "我", shares: 6, participants: ["我", "小李", "小王", "小张", "老陈", "阿敏"] },
  { id: "e2", date: "2026-10-06", category: "住宿", title: "沟口客栈 2 间 2 晚", amount: 2400, currency: "CNY", rate: 1, paidBy: "我", shares: 6, participants: ["我", "小李", "小王", "小张", "老陈", "阿敏"] },
  { id: "e3", date: "2026-10-07", category: "餐饮", title: "藏式晚餐", amount: 420, currency: "CNY", rate: 1, paidBy: "小李", shares: 6, participants: ["我", "小李", "小王", "小张", "老陈", "阿敏"] },
];
// CheckIn：{ at: ISO 字符串, note: string }，**键必须是活动键而非地点名**。
// readCheckIn 依次尝试 activityStableKey（v2:...）、activityHistoricalStableKey、
// activityLegacyStableKey、activityKey（`${date}#${index}#${title}`）。
// 写成 "九寨沟沟口": {...} 能通过 sanitizeCheckIns（它只校验值的形状），
// 但没有任何活动会匹配到它，界面上表现为"打卡记录存在但完成率 0%"。
// 这里用 activityKey 的形式，指向 trip.days[0] 的第 0 和第 2 个活动。
const day1 = trip.days[0];
const checkIns = {
  [`${day1.date}#0#${day1.activities[0].title}`]: { at: "2026-10-06T08:00:00.000Z", note: "大巴准点发车" },
  [`${day1.date}#2#${day1.activities[2].title}`]: { at: "2026-10-06T17:20:00.000Z", note: "入住完成" },
};
const prepState = { "todo:1": true, "todo:2": true };
// PackingItem：id/label/category/checked(+custom/reason)。
// 注意是 `label` 不是 `title`，且 category 必须属于 packingCategories 白名单。
const packing = [
  { id: "p1", label: "身份证", category: "证件", checked: true, reason: "国内出行必备" },
  { id: "p2", label: "冲锋衣", category: "衣物", checked: false, reason: "山区昼夜温差大" },
  { id: "p3", label: "常用药品", category: "药品", checked: false },
];

const built = backup.buildBackupData({
  trip,
  plannerInput,
  // 不要传 null：buildBackupData 只跳过 undefined，null 会被当成"有效的天气数据"
  // 写进备份，恢复时被 schema 判为无效并整体拒绝（这是失败安全，但会误导测试）。
  weather: undefined,
  expenses,
  checkIns,
  prepState,
  packing,
});

// buildBackupData 返回的是 { sections, data }，
// 真正要写进备份体的是 `built.data`（早期脚本误把整个返回对象当数据段，
// 结果恢复时报"备份不含任何数据段"）。
const builtData = built.data;

const meta = {
  schemaVersion: backup.BACKUP_SCHEMA_VERSION,
  appVersion: "0.4.0",
  source: "android",
  createdAt: new Date().toISOString(),
  // 真实的分区列表取自 buildBackupData，不要写死 ALL_SECTIONS：
  // 否则 weather 为 null 时分区列表与实际数据段不一致。
  sections: built.sections,
};

// 与 backup.ts 的 BackupFile 类型严格对齐：字段是**平铺**的，
// 不是嵌在 meta / payload 下面（早期版本这里写错过，导入会报"格式不受支持"）。
let file;
if (passphrase) {
  const encrypted = await backup.encryptBackup(meta, builtData, passphrase);
  file = {
    format: backup.BACKUP_FORMAT_ID,
    encrypted: true,
    ...encrypted,
  };
} else {
  const checksum = await backup.sha256Hex(stableStringify(builtData));
  file = {
    format: backup.BACKUP_FORMAT_ID,
    encrypted: false,
    ...meta,
    data: builtData,
    checksum,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(file, null, 2), "utf8");
const size = fs.statSync(outPath).size;
console.log(`生成 ${outPath}`);
console.log(`  加密：${passphrase ? "是" : "否"}  大小：${size} 字节  分区：${meta.sections.join(",")}`);
