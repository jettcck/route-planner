/**
 * 应用锁：可选的 4～8 位数字口令 / 图形无关的本地锁。
 *
 * 为什么用 WebCrypto 而不是系统生物识别
 * - 生物识别（BiometricPrompt）需要新写一个 Kotlin 插件并登记 ACL，改动面大；
 * - 4～8 位数字口令 + PBKDF2 在本机足够防"手机被别人拿起来看"，且完全离线；
 * - 口令只存 PBKDF2 摘要（Android 上再经 Keystore 加密存储），**不存明文**。
 *
 * 安全边界（必须如实告诉用户）
 * - 这是"应用内锁"，不是磁盘加密：数据仍在应用私有目录里，
 *   拿到已 root 设备或做过完整备份的对手可以绕过。
 * - 连续输错 5 次锁定 60 秒，防止边看边试。
 */
import { isAndroidSecureStore, readSecureEntry, writeSecure } from "./secure-store";
import { loadJson, saveJson } from "./store";

const LOCK_KEY = "route-app-lock";
const FAIL_KEY = "route-app-lock-fails";
const ITERATIONS = 120_000;

export type LockConfig = {
  salt: string;
  digest: string;
  iterations: number;
  /** 是否已启用；关闭时保留摘要但 unlocked 为 true */
  enabled: boolean;
  updatedAt: number;
};

type FailState = { count: number; until: number };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    base,
    256,
  );
  return Array.from(new Uint8Array(bits)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validPin(pin: string): string {
  if (!/^\d{4,8}$/.test(pin)) return "口令需为 4～8 位数字";
  if (/^(\d)\1+$/.test(pin)) return "不要使用全部相同的数字";
  if (["1234", "12345", "123456", "1234567", "12345678", "0000", "1111"].includes(pin)) return "该口令过于简单";
  return "";
}

/** 读取当前锁配置；Android 优先从 Keystore 读，失败时不回落到 localStorage。 */
export async function readLockConfig(): Promise<LockConfig | null> {
  if (isAndroidSecureStore()) {
    const result = await readSecureEntry<LockConfig>(LOCK_KEY);
    if (!result.ok) return null;
    return result.found ? sanitize(result.value) : null;
  }
  return sanitize(loadJson<unknown>(LOCK_KEY, null));
}

function sanitize(value: unknown): LockConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Partial<LockConfig>;
  if (typeof config.salt !== "string" || !config.salt) return null;
  if (typeof config.digest !== "string" || !/^[0-9a-f]{64}$/.test(config.digest)) return null;
  if (typeof config.iterations !== "number" || config.iterations < 50_000) return null;
  if (typeof config.enabled !== "boolean") return null;
  return {
    salt: config.salt,
    digest: config.digest,
    iterations: config.iterations,
    enabled: config.enabled,
    updatedAt: typeof config.updatedAt === "number" ? config.updatedAt : 0,
  };
}

export async function setLockPin(pin: string): Promise<boolean> {
  const error = validPin(pin);
  if (error) throw new Error(error);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const config: LockConfig = {
    salt: toBase64(salt),
    digest: await derive(pin, salt, ITERATIONS),
    iterations: ITERATIONS,
    enabled: true,
    updatedAt: Date.now(),
  };
  if (isAndroidSecureStore()) {
    const ok = await writeSecure(LOCK_KEY, config);
    if (!ok) return false;
  } else if (!saveJson(LOCK_KEY, config)) {
    return false;
  }
  clearFails();
  return true;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const config = await readLockConfig();
  if (!config) return false;
  const digest = await derive(pin, fromBase64(config.salt), config.iterations);
  return digest === config.digest;
}

export async function disableLock(): Promise<boolean> {
  const config = await readLockConfig();
  if (!config) return true;
  const next: LockConfig = { ...config, enabled: false, updatedAt: Date.now() };
  if (isAndroidSecureStore()) return writeSecure(LOCK_KEY, next);
  return saveJson(LOCK_KEY, next);
}

// 曾经导出过 forgetLock()：无验证直接删除锁配置。
// 它等于"忘记口令"后门——任何拿到手机的人点两下就能关掉应用锁，
// 与"防止手机被他人临时查看"的设计目标直接冲突，故移除。
// 忘记口令的正解是重新安装应用（本地数据在卸载时一并清空），
// 不是在后门里偷偷保留一条无验证通路。
// 若将来要恢复自助重置，必须先在 Android 上落地生物识别或恢复码校验，
// 并在通过校验后才允许删除 LOCK_KEY。

// ------------------------------------------------------------------ 失败计数

export function readFails(): FailState {
  const value = loadJson<unknown>(FAIL_KEY, { count: 0, until: 0 });
  if (!value || typeof value !== "object") return { count: 0, until: 0 };
  const state = value as Partial<FailState>;
  return {
    count: Number.isInteger(state.count) && (state.count as number) > 0 ? (state.count as number) : 0,
    until: Number.isFinite(state.until) ? (state.until as number) : 0,
  };
}

export function clearFails() {
  saveJson(FAIL_KEY, { count: 0, until: 0 });
}

/** 记录一次失败；第 5 次起锁定 60 秒，返回剩余锁定秒数。 */
export function recordFail(): number {
  const state = readFails();
  const count = state.count + 1;
  const until = count >= 5 ? Date.now() + 60_000 : 0;
  saveJson(FAIL_KEY, { count: until ? 0 : count, until });
  return until ? 60 : 0;
}
