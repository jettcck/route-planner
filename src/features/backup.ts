/**
 * `.routebackup` 备份格式：加密、校验、快照与恢复投影。
 *
 * 设计
 * - 容器是纯文本 JSON，扩展名 `.routebackup`，可被系统分享/文件选择器识别。
 * - 明文包（不加密）需要 `checksum` 覆盖 payload，用于发现传输/编辑损坏；
 *   加密包由 AES-GCM 自带认证标签保证完整性，因此不再叠 checksum。
 * - `schemaVersion` 独立于应用版本：应用升级不应让老备份失效。
 * - `sections` 用「已打包的数据块名称」表达，导入侧据此决定要覆盖哪些键，
 *   未出现的块保持本机原样，避免「只想恢复记账却把行程冲掉」。
 *
 * 安全边界
 * - 加密使用 PBKDF2-SHA256（310000 次，与 OWASP 2023+ 建议一致）派生 256 位密钥，
 *   AES-GCM 随机 12 字节 IV；盐与 IV 随包保存，口令**永不**写入文件。
 * - WebCrypto 在 Tauri 的 Android WebView 中可用（requires secure context，
 *   tauri.localhost 满足要求）。
 */
import { loadStored, saveJson } from "./store";

export const BACKUP_EXTENSION = ".routebackup";
export const BACKUP_SCHEMA_VERSION = 4;
export const BACKUP_FORMAT_ID = "route-backup";

/** 单个备份文件的硬上限；超过即为异常输入，不做解析。 */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
/** 本地滚动快照保留数量（用户要求 3～5 个）。 */
export const MAX_SNAPSHOTS = 5;

export type BackupSection =
  | "trip"
  | "input"
  | "weather"
  | "expenses"
  | "checkIns"
  | "prepState"
  | "packing";

export const ALL_SECTIONS: BackupSection[] = [
  "trip",
  "input",
  "weather",
  "expenses",
  "checkIns",
  "prepState",
  "packing",
];

export const SECTION_LABELS: Record<BackupSection, string> = {
  trip: "行程",
  input: "规划条件",
  weather: "天气快照",
  expenses: "记账明细",
  checkIns: "打卡记录",
  prepState: "出行提醒待办",
  packing: "打包清单",
};

type Payload = Record<string, unknown>;

export type PlainBackup = {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  source: string;
  sections: BackupSection[];
  data: Payload;
  checksum: string;
};

export type EncryptedBackup = {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  source: string;
  sections: BackupSection[];
  encryption: {
    alg: "AES-GCM";
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
};

export type BackupFile = (PlainBackup | EncryptedBackup) & {
  format: typeof BACKUP_FORMAT_ID;
  encrypted: boolean;
};

export type BackupSummary = {
  createdAt: string;
  appVersion: string;
  source: string;
  encrypted: boolean;
  schemaVersion: number;
  counts: { label: string; count: number }[];
};

// ------------------------------------------------------------------ 工具

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // 分块避免超长参数导致 apply 栈溢出（大备份可达数 MB）。
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + CHUNK)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** SHA-256 十六进制摘要；用于明文包的完整性校验。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 对 payload 做稳定序列化：键排序，保证同样的数据总能算出同样的摘要。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

// ------------------------------------------------------------------ 打包

export function buildBackupData(input: {
  trip: unknown;
  plannerInput: unknown;
  weather: unknown;
  expenses: unknown;
  checkIns: unknown;
  prepState: unknown;
  packing: unknown;
  sections?: BackupSection[];
}): { sections: BackupSection[]; data: Payload } {
  const wanted = input.sections ?? ALL_SECTIONS;
  const data: Payload = {};
  const sections: BackupSection[] = [];
  const assign = (key: BackupSection, value: unknown) => {
    if (!wanted.includes(key) || value === undefined) return;
    data[key] = value;
    sections.push(key);
  };
  assign("trip", input.trip);
  assign("input", input.plannerInput);
  assign("weather", input.weather);
  assign("expenses", input.expenses);
  assign("checkIns", input.checkIns);
  assign("prepState", input.prepState);
  assign("packing", input.packing);
  return { sections, data };
}

// ------------------------------------------------------------------ 加密

const PBKDF2_ITERATIONS = 310_000;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBackup(
  meta: { appVersion: string; source: string; sections: BackupSection[] },
  data: Payload,
  passphrase: string,
): Promise<EncryptedBackup> {
  if (passphrase.length < 8) throw new Error("备份口令至少 8 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(stableStringify(data)),
  );
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: meta.appVersion,
    createdAt: new Date().toISOString(),
    source: meta.source,
    sections: meta.sections,
    encryption: {
      alg: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
  };
}

export async function decryptBackup(
  file: EncryptedBackup,
  passphrase: string,
): Promise<Payload> {
  const { encryption } = file;
  if (!encryption || encryption.alg !== "AES-GCM" || encryption.kdf !== "PBKDF2-SHA256") {
    throw new Error("备份加密参数不受支持");
  }
  if (!Number.isInteger(encryption.iterations) || encryption.iterations < 100_000 || encryption.iterations > 2_000_000) {
    throw new Error("备份加密参数异常");
  }
  const key = await deriveKey(passphrase, base64ToBytes(encryption.salt), encryption.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(encryption.iv) as unknown as BufferSource },
      key,
      base64ToBytes(file.ciphertext) as unknown as BufferSource,
    );
  } catch {
    // AES-GCM 认证失败只有一种合理解释：口令错误或文件被篡改。
    throw new Error("口令错误，或备份文件已损坏");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as Payload;
}

// ------------------------------------------------------------------ 解析

export function isBackupFile(value: unknown): value is BackupFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT_ID) return false;
  if (typeof file.schemaVersion !== "number" || !Number.isInteger(file.schemaVersion)) return false;
  if (file.schemaVersion < 1 || file.schemaVersion > BACKUP_SCHEMA_VERSION) return false;
  if (!Array.isArray(file.sections)) return false;
  return true;
}

/**
 * 解析备份文件；加密包在未提供口令时只返回元信息，由调用方再要口令。
 * 这一步只做结构校验，**不**校验业务字段——业务校验在导入时用 schema 完成。
 */
export async function parseBackupFile(
  text: string,
  passphrase?: string,
): Promise<{ file: BackupFile; data: Payload | null; needsPassphrase: boolean; checksumOk: boolean }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效的 JSON，可能已损坏");
  }
  if (!isBackupFile(raw)) throw new Error("这不是途迹的 .routebackup 备份文件，或版本不受支持");
  const file = raw as BackupFile;
  if (file.encrypted) {
    if (!(file as EncryptedBackup).ciphertext) throw new Error("备份文件缺少加密数据");
    if (!passphrase) {
      return { file, data: null, needsPassphrase: true, checksumOk: true };
    }
    const data = await decryptBackup(file as EncryptedBackup, passphrase);
    return { file, data, needsPassphrase: false, checksumOk: true };
  }
  const plain = file as PlainBackup;
  if (!plain.data || typeof plain.data !== "object") throw new Error("备份文件缺少数据段");
  if (typeof plain.checksum !== "string" || !/^[0-9a-f]{64}$/.test(plain.checksum)) {
    throw new Error("备份文件缺少有效的校验值");
  }
  const actual = await sha256Hex(stableStringify(plain.data));
  if (actual !== plain.checksum) throw new Error("备份文件校验失败：内容不完整或被修改过");
  return { file, data: plain.data, needsPassphrase: false, checksumOk: true };
}

// ------------------------------------------------------------------ 概要

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as object).length;
  return value === undefined || value === null ? 0 : 1;
}

/**
 * 导入前展示的概要：让用户在覆盖本机数据之前看清「要导入什么、有多少」。
 * 行程额外统计天数和活动数，因为只有天数/活动数才能反映真实体量。
 */
export function summarizeBackup(file: BackupFile, data: Payload | null, encrypted: boolean): BackupSummary {
  const counts: { label: string; count: number }[] = [];
  if (data) {
    const trip = data.trip as { days?: { activities?: unknown[] }[] } | undefined;
    if (Array.isArray(trip?.days)) {
      const activities = trip.days.reduce((sum, day) => sum + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
      counts.push({ label: "行程天数", count: trip.days.length });
      counts.push({ label: "活动条目", count: activities });
    }
    for (const section of ALL_SECTIONS) {
      if (section === "trip" || data[section] === undefined) continue;
      counts.push({ label: SECTION_LABELS[section], count: countOf(data[section]) });
    }
  }
  return {
    createdAt: file.createdAt,
    appVersion: file.appVersion,
    source: file.source,
    encrypted,
    schemaVersion: file.schemaVersion,
    counts,
  };
}

// ------------------------------------------------------------------ 快照

const SNAPSHOT_INDEX_KEY = "route-snapshots";
const SNAPSHOT_KEY_PREFIX = "route-snapshot:";

export type SnapshotMeta = {
  id: string;
  createdAt: string;
  appVersion: string;
  sections: BackupSection[];
  /** 概览：用于在「恢复」列表里直接展示，不必解析每个快照体。 */
  counts: { label: string; count: number }[];
  size: number;
};

type SnapshotIndex = SnapshotMeta[];

/** 快照只在写入成功后索引；失败的快照不能出现在恢复列表里。 */
export function listSnapshots(): SnapshotIndex {
  const list = loadStored<SnapshotIndex>(SNAPSHOT_INDEX_KEY, [], (value) =>
    Array.isArray(value) ? (value.filter(validMeta) as SnapshotIndex) : undefined,
  );
  return Array.isArray(list) ? list : [];
}

function validMeta(value: unknown): value is SnapshotMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<SnapshotMeta>;
  return typeof meta.id === "string" && /^[A-Za-z0-9-]{6,64}$/.test(meta.id) &&
    typeof meta.createdAt === "string" &&
    Array.isArray(meta.sections) &&
    Array.isArray(meta.counts) &&
    typeof meta.size === "number";
}

export type SnapshotPayload = {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  sections: BackupSection[];
  data: Payload;
};

/** 读取单个快照；返回 null 表示该快照已不可用（存储损坏或被清理）。 */
export function readSnapshot(id: string): SnapshotPayload | null {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) return null;
  const value = loadStored<SnapshotPayload | null>(`${SNAPSHOT_KEY_PREFIX}${id}`, null, (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw as Partial<SnapshotPayload>;
    if (!payload.data || typeof payload.data !== "object") return null;
    if (!Array.isArray(payload.sections)) return null;
    return raw as SnapshotPayload;
  });
  return value && typeof value === "object" ? value : null;
}

export function newSnapshotId(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return `${Date.now().toString(36)}-${Array.from(random).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 写入一个滚动快照，并清理超出 MAX_SNAPSHOTS 的旧快照。
 *
 * 返回 false 表示存储写满或不可用——调用方必须把这种情况当成「保护失效」提示用户，
 * 而不是静默成功。
 */
export function writeSnapshot(meta: Omit<SnapshotMeta, "size">, payload: SnapshotPayload): boolean {
  const body = JSON.stringify(payload);
  if (!saveJson(`${SNAPSHOT_KEY_PREFIX}${meta.id}`, payload)) return false;
  const index = listSnapshots().filter((item) => item.id !== meta.id);
  index.unshift({ ...meta, size: body.length });
  const kept = index.slice(0, MAX_SNAPSHOTS);
  // 先删旧体再写索引：即使中途失败，最坏结果是索引里指向一个已删除的快照，
  // readSnapshot 返回 null 会被 UI 标记为不可用，不会误删用户数据。
  for (const dropped of index.slice(MAX_SNAPSHOTS)) {
    try { localStorage.removeItem(`${SNAPSHOT_KEY_PREFIX}${dropped.id}`); } catch { /* best effort */ }
  }
  return saveJson(SNAPSHOT_INDEX_KEY, kept);
}

export function deleteSnapshot(id: string): boolean {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id)) return false;
  try { localStorage.removeItem(`${SNAPSHOT_KEY_PREFIX}${id}`); } catch { return false; }
  return saveJson(SNAPSHOT_INDEX_KEY, listSnapshots().filter((item) => item.id !== id));
}

// ------------------------------------------------------------------ 恢复投影

export function backupCounts(data: Payload | null): { label: string; count: number }[] {
  if (!data) return [];
  const counts: { label: string; count: number }[] = [];
  for (const section of ALL_SECTIONS) {
    if (data[section] === undefined) continue;
    counts.push({ label: SECTION_LABELS[section], count: countOf(data[section]) });
  }
  return counts;
}

/** 生成人类可读的备份文件名：目的地 + 日期 + 扩展名。 */
export function backupFileName(destination: string, date = new Date()): string {
  const safe = (destination || "旅行").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return `${safe}-${stamp}${BACKUP_EXTENSION}`;
}

