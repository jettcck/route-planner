import { useCallback, useEffect, useState } from "react";
import { legacyStorageKey } from "./storage-keys";

export { legacyTripNamespace, tripNamespace } from "./storage-keys";

/**
 * localStorage 读写工具。
 * App 端所有离线数据（行李清单、记账、打卡、行前待办）都走这里，
 * 保证断网时功能完整可用。
 */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readRawJson(key: string): { found: boolean; parsed: boolean; value: unknown } {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { found: false, parsed: false, value: undefined };
    return { found: true, parsed: true, value: JSON.parse(raw) as unknown };
  } catch {
    // A truncated or otherwise malformed old entry should not permanently
    // hide a valid pre-v2 copy during an app upgrade.
    return { found: true, parsed: false, value: undefined };
  }
}

/** Read a new key, falling back once to the pre-v2 namespace for upgrades. */
function loadScoped<T>(key: string, fallback: T, sanitize?: StoredValueSanitizer<T>): T {
  const current = readRawJson(key);
  if (current.found && current.parsed) return compatibleValue(current.value, fallback, sanitize);
  const oldKey = legacyStorageKey(key);
  if (!oldKey) return fallback;
  const legacy = readRawJson(oldKey);
  if (!legacy.found) return fallback;
  const value = compatibleValue(legacy.value, fallback, sanitize);
  // Best-effort migration. The old record remains intact until the new value
  // has been written, so a quota failure cannot destroy the only copy.
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Once the new copy is durable, remove the legacy duplicate. If removal
    // fails the new key remains authoritative and a later startup can retry.
    localStorage.removeItem(oldKey);
  } catch { /* saveJson reports later writes */ }
  return value;
}

/** Read a trip-scoped value with the same one-time legacy-key migration used
 * by React state. Exporters and other non-hook callers must use this helper so
 * an upgrade cannot silently omit data that has not been rendered yet. */
export function loadStored<T>(key: string, fallback: T, sanitize?: StoredValueSanitizer<T>): T {
  return loadScoped(key, fallback, sanitize);
}

export const STORAGE_WRITE_FAILED_EVENT = "route-storage-write-failed";

function reportStorageWriteFailure(key: string) {
  // Keep persistence failures visible to the app without coupling this low-level
  // helper to React. Some Android WebViews expose localStorage but reject writes
  // later (quota, private mode, or a damaged storage database).
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(STORAGE_WRITE_FAILED_EVENT, {
      detail: { key },
    }));
  } catch {
    // Event dispatch is best effort; the boolean return still protects callers.
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 由调用方决定如何提示；返回 false 避免把存储失败伪装成成功。
    reportStorageWriteFailure(key);
    return false;
  }
}

type Slot<T> = { key: string; value: T };

export type StoredValueSanitizer<T> = (value: unknown) => T | undefined;

function compatibleValue<T>(value: unknown, fallback: T, sanitize?: StoredValueSanitizer<T>): T {
  if (sanitize) {
    const cleaned = sanitize(value);
    return cleaned === undefined ? fallback : cleaned;
  }
  if (Array.isArray(fallback)) {
    return Array.isArray(value)
      ? value.filter((item) => item !== null && typeof item === "object") as T
      : fallback;
  }
  if (fallback !== null && typeof fallback === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as T
      : fallback;
  }
  return value === undefined ? fallback : value as T;
}

/** 随 key 切换自动换数据源的持久化状态。 */
export function useStoredState<T>(key: string, fallback: T, sanitize?: StoredValueSanitizer<T>) {
  const [slot, setSlot] = useState<Slot<T>>(() => ({
    key,
    value: loadScoped(key, fallback, sanitize),
  }));

  // A key can change during render (for example when the user switches the
  // destination or departure date). The effect below cannot commit the new
  // slot until after that render, so returning slot.value here would briefly
  // show the previous trip's ledger/check-ins/todos under the new trip. Read
  // the new namespace for that one render; the state update in the effect
  // then takes over and subsequent renders use the cached slot.
  const visibleValue = slot.key === key
    ? slot.value
    : loadScoped(key, fallback, sanitize);

  useEffect(() => {
    const value = loadScoped(key, fallback, sanitize);
    setSlot((previous) => previous.key === key ? previous : { key, value });
    // fallback 和 sanitizer 只是当前 key 的解析策略；它们通常是每次渲染
    // 都会创建的新引用，不应让同一个命名空间反复从 localStorage 重载。
  }, [key]);

  const update = useCallback((next: T | ((previous: T) => T)) => {
    setSlot((previous) => {
      // key 变化但 effect 尚未提交时，先读取新命名空间再应用更新。
      // 直接丢弃这次操作会让用户在切换行程后立刻勾选清单、记账或
      // 打卡时丢失首个点击；使用新 key 作为 slot 仍能避免串写旧行程。
      const base = previous.key === key
        ? previous.value
        : loadScoped(key, fallback, sanitize);
      const value =
        typeof next === "function"
          ? (next as (value: T) => T)(base)
          : next;
      return { key, value };
    });
  }, [fallback, key, sanitize]);

  useEffect(() => {
    if (slot.key === key) saveJson(slot.key, slot.value);
  }, [key, slot]);
  return [visibleValue, update] as const;
}

export function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}
