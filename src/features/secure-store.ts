import { invoke, isTauri } from "@tauri-apps/api/core";
import { STORAGE_WRITE_FAILED_EVENT } from "./store";

const android =
  isTauri() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
const SECURE_OPERATION_TIMEOUT_MS = 5_000;

// A timeout only stops waiting in JavaScript; Tauri does not cancel the
// already-dispatched native invocation. Keep a tail for the real native
// Promise so a retry, login, or logout cannot start before a timed-out write
// has actually settled and then resurrect an older value.
let nativeOperationTail: Promise<void> = Promise.resolve();

/**
 * A native bridge call normally resolves immediately, but a Keystore prompt,
 * activity replacement, or a broken WebView can leave the Promise pending
 * forever. Bound each attempt so the login screen can surface a recoverable
 * storage error instead of keeping the startup splash up indefinitely.
 */
async function invokeSecureWithTimeout<T>(command: string, args: Record<string, unknown>): Promise<T> {
  let timer = 0;
  const operation = nativeOperationTail.then(() => invoke<T>(command, args));
  // Attach rejection handling immediately: callers may receive the timeout
  // first, while the native operation can reject later in the background.
  nativeOperationTail = operation.then(() => undefined, () => undefined);
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("secure storage operation timed out")),
          SECURE_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

export function isAndroidSecureStore() {
  return android;
}

export type SecureReadResult<T> = {
  /** Whether the native read itself completed successfully. */
  ok: boolean;
  /** Whether the key exists in the secure store. */
  found: boolean;
  value: T | null;
};

/**
 * Read with presence information so migrations can distinguish an empty,
 * intentionally saved value from a key that has never been migrated.
 */
export async function readSecureEntry<T>(key: string): Promise<SecureReadResult<T>> {
  if (!android) return { ok: true, found: false, value: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let result: { value?: string | null };
    try {
      result = await invokeSecureWithTimeout<{ value?: string | null }>("plugin:secure-storage|secure_get", { key });
    } catch {
      // The WebView/native bridge can be briefly unavailable while the
      // activity and Keystore are starting. Retry without treating that as a
      // missing credential; callers must never fall back to legacy plaintext
      // storage after a failed secure read.
      if (attempt < 2) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      return { ok: false, found: false, value: null };
    }
    if (!result?.value) return { ok: true, found: false, value: null };
    try {
      return { ok: true, found: true, value: JSON.parse(result.value) as T };
    } catch {
      // A corrupt secure value must not resurrect a stale legacy copy.
      return { ok: false, found: true, value: null };
    }
  }
  return { ok: false, found: false, value: null };
}

export async function readSecure<T>(key: string, fallback: T): Promise<T> {
  const result = await readSecureEntry<T>(key);
  return result.ok && result.found && result.value !== null ? result.value : fallback;
}

async function invokeSecureWithRetry<T>(command: string, args: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invokeSecureWithTimeout<T>(command, args);
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw new Error("secure storage operation failed");
}

export async function writeSecure(key: string, value: unknown) {
  if (!android) return false;
  try {
    await invokeSecureWithRetry("plugin:secure-storage|secure_set", { key, value: JSON.stringify(value) });
    return true;
  } catch {
    reportSecureStoreFailure(key);
    return false;
  }
}

export async function deleteSecure(key: string) {
  if (!android) return false;
  try {
    await invokeSecureWithRetry("plugin:secure-storage|secure_delete", { key });
    return true;
  } catch {
    reportSecureStoreFailure(key);
    return false;
  }
}

function reportSecureStoreFailure(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(STORAGE_WRITE_FAILED_EVENT, {
      detail: { key, secure: true },
    }));
  } catch {
    // The boolean result remains the source of truth for callers.
  }
}
