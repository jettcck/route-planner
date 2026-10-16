/**
 * 账号模块：校验规则 + 接口客户端 + 登录态。
 *
 * 设计要点
 * - 校验规则与后端 login-demo/src/validators.js 一一对应，前端先拦一道，减少无效请求；
 * - Tauri 端（桌面 / 安卓 WebView）用 Bearer Token + localStorage 保存会话；
 *   同一后端也支持 Cookie，浏览器页面直接访问时无需改代码；
 * - 全程**不阻塞本机功能**：未登录时行程、打包、记账、打卡照常可用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { loadJson, saveJson } from "./store";
import { deleteSecure, isAndroidSecureStore, readSecureEntry, writeSecure } from "./secure-store";
import { requestAccount, type ApiResult } from "./auth-request";
import type { AgentContext } from "../../shared/travel-agent.mjs";

// ----------------------------------------------------------------- 类型
export type AuthUser = {
  id: number;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
};

export type AuthSession = {
  token: string;
  user: AuthUser;
  savedAt: number;
};

function validAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<AuthUser>;
  return Number.isInteger(user.id) && (user.id as number) > 0 &&
    (user.email === null || (typeof user.email === "string" && user.email.length > 0 && user.email.length <= 254)) &&
    (user.phone === null || (typeof user.phone === "string" && user.phone.length > 0 && user.phone.length <= 32)) &&
    (user.nickname === null || (typeof user.nickname === "string" && user.nickname.length <= 80)) &&
    (user.email !== null || user.phone !== null) &&
    typeof user.emailVerified === "boolean" && typeof user.phoneVerified === "boolean";
}

function validAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AuthSession>;
  return typeof session.token === "string" && session.token.length >= 16 && session.token.length <= 512 &&
    Number.isFinite(session.savedAt) && validAuthUser(session.user);
}

/** Validate the complete response before it reaches React state or storage. */
function validAuthPayloadResponse(value: Record<string, unknown>): boolean {
  return (value.action === "login" || value.action === "registered") &&
    typeof value.token === "string" && value.token.length >= 16 && value.token.length <= 512 &&
    validAuthUser(value.user);
}

function validUserResponse(value: Record<string, unknown>): boolean {
  return validAuthUser(value.user);
}

function validLogoutResponse(value: Record<string, unknown>): boolean {
  return value.action === "logged_out";
}

function validAiResponse(value: Record<string, unknown>): boolean {
  return typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= 256 * 1024;
}

function validPasswordResetCodeResponse(value: Record<string, unknown>): boolean {
  return typeof value.email === "string" && typeof value.expiresIn === "number" && Number.isFinite(value.expiresIn) &&
    (value.devCode === undefined || (typeof value.devCode === "string" && /^\d{6}$/.test(value.devCode)));
}

function validPasswordResetResponse(value: Record<string, unknown>): boolean {
  return value.action === "password_reset";
}

function validHealthResponse(value: Record<string, unknown>): boolean {
  return value.service === "route-auth" && typeof value.aiConfigured === "boolean";
}

export type Channel = "email" | "sms";

export type ServiceHealth = { service: string; aiConfigured: boolean };

// ----------------------------------------------------------------- 常量
const SESSION_KEY = "route.auth.session";
const ENDPOINT_KEY = "route.auth.endpoint";
export const AUTH_ENDPOINT_CHANGED_EVENT = "route-auth-endpoint-changed";
// Android Keystore is authoritative, but a local timestamp gives startup a
// second guard if both delete and tombstone writes temporarily fail (for
// example while the device is out of storage). A later login has a newer
// savedAt and is therefore not blocked by the old logout marker.
const LOGOUT_TOMBSTONE_KEY = "route.auth.logout-at";

/**
 * 本地开发默认地址。
 * 安卓端 WebView 里 localhost 指向设备自己，宿主机要用模拟器的 10.0.2.2；
 * 桌面 / 浏览器默认使用 IPv4 回环地址，避免 localhost 被解析到 IPv6。
 * 用户也可在「账号服务地址」里手改。
 */
// A browser opened on an Android phone is still a normal web client. The
// previous user-agent-only check treated the Codex/Chrome preview as a native
// WebView and blanked the development endpoint, making the login panel show a
// false "service unavailable" state even while the local account service was healthy.
// Restrict the Android branch to an actual Tauri container, where localhost
// points at the device rather than the development computer.
const IS_TAURI_ANDROID =
  isTauri() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
const ACCOUNT_ENDPOINT_LOCKED =
  import.meta.env.PROD && import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS !== "true";

export const DEFAULT_ENDPOINT =
  (import.meta.env.VITE_AUTH_ENDPOINT?.trim() ||
    (!import.meta.env.PROD
      ? IS_TAURI_ANDROID ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787"
      : ""));

/** 与后端保持一致的归一化 */
export const normalizeEmail = (raw: string) => (raw ?? "").trim().toLowerCase();
export const normalizePhone = (raw: string) =>
  (raw ?? "").replace(/[\s\-()]/g, "").replace(/^(\+?86|0086)/, "").replace(/\D/g, "");

export const QQ_EMAIL_RE =
  /^(?:[1-9]\d{4,10}@qq\.com|[A-Za-z0-9][A-Za-z0-9._-]{2,31}@foxmail\.com)$/;
export const CN_PHONE_RE = /^1[3-9]\d{9}$/;

// ----------------------------------------------------------------- 校验
export function checkEmail(raw: string): string {
  const v = normalizeEmail(raw);
  if (!v) return "请输入邮箱地址";
  if (v.length > 254) return "邮箱地址过长";
  if (!/^[^@\s]+@[^@\s]+$/.test(v)) return "邮箱格式不正确";
  if (!QQ_EMAIL_RE.test(v)) return "仅支持 QQ 邮箱：数字 QQ 号@qq.com 或 别名@foxmail.com";
  return "";
}

export function checkPhone(raw: string): string {
  const v = normalizePhone(raw);
  if (!v) return "请输入手机号";
  if (v.length !== 11) return "手机号应为 11 位数字";
  if (!CN_PHONE_RE.test(v)) return "手机号格式不正确";
  return "";
}

export function checkPassword(raw: string): string {
  if (!raw) return "请输入密码";
  if (raw.length < 8) return "密码至少 8 位";
  if (raw.length > 32) return "密码最多 32 位";
  if (/\s/.test(raw)) return "密码不能包含空格";
  if (!/[A-Za-z]/.test(raw) || !/\d/.test(raw)) return "密码需同时包含字母和数字";
  return "";
}

export function checkCode(raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "请输入验证码";
  if (!/^\d{6}$/.test(v)) return "验证码为 6 位数字";
  return "";
}

/** 密码强度：0 弱 1 中 2 强（纯前端提示，不参与提交） */
export function passwordStrength(raw: string): 0 | 1 | 2 {
  if (raw.length < 8) return 0;
  let score = 0;
  if (/[a-z]/.test(raw)) score += 1;
  if (/[A-Z]/.test(raw)) score += 1;
  if (/\d/.test(raw)) score += 1;
  if (/[^A-Za-z0-9]/.test(raw)) score += 1;
  if (raw.length >= 12) score += 1;
  return score >= 4 ? 2 : score >= 3 ? 1 : 0;
}

// ----------------------------------------------------------------- 端点
export function getEndpoint(): string {
  // A shipped build must never let stale WebView storage redirect credentials
  // to an old, forked, or attacker-controlled account service. The endpoint is
  // injected at build time and is the only production source of truth.
  if (ACCOUNT_ENDPOINT_LOCKED) {
    if (!DEFAULT_ENDPOINT) return "";
    try { return validateEndpoint(DEFAULT_ENDPOINT); } catch { return ""; }
  }
  const saved = loadJson<unknown>(ENDPOINT_KEY, null);
  let value = typeof saved === "string" && saved.trim() ? saved : DEFAULT_ENDPOINT;
  // Older development builds persisted localhost. Node/Vite's local service
  // binds IPv4 (0.0.0.0), while some WebViews prefer IPv6 ::1 for localhost
  // and fail without falling back. Canonicalize only development loopback
  // storage so upgrades recover automatically; production remains HTTPS-only.
  if (!import.meta.env.PROD && typeof value === "string") {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === "http:" && parsed.hostname.toLowerCase() === "localhost") {
        parsed.hostname = "127.0.0.1";
        value = parsed.toString().replace(/\/$/, "");
      }
    } catch {
      // validateEndpoint below reports the actionable configuration error.
    }
  }
  if (!value) return "";
  try {
    return validateEndpoint(value);
  } catch {
    // A development HTTP endpoint may remain in WebView storage after an
    // upgrade to a production build. Never reuse it for authenticated traffic.
    return "";
  }
}
export function setEndpoint(value: string) {
  if (ACCOUNT_ENDPOINT_LOCKED) throw new Error("正式版本的账号服务地址由发布配置固定，不能在设备上修改");
  const normalized = validateEndpoint(value);
  if (!saveJson(ENDPOINT_KEY, normalized)) {
    throw new Error("账号服务地址保存失败，请检查设备存储空间");
  }
  try {
    window.dispatchEvent(new Event(AUTH_ENDPOINT_CHANGED_EVENT));
  } catch {
    // Non-browser callers can still persist the endpoint; the next health
    // check will observe it directly.
  }
}

function validateEndpoint(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("账号服务地址不能为空");
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error("账号服务地址格式不正确"); }
  const hostname = parsed.hostname.toLowerCase();
  const privateIpv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const isPrivateIpv4 = Boolean(privateIpv4 && (
    privateIpv4[1] === "10" ||
    (privateIpv4[1] === "172" && Number(privateIpv4[2]) >= 16 && Number(privateIpv4[2]) <= 31) ||
    (privateIpv4[1] === "192" && privateIpv4[2] === "168")
  ));
  // The local Android acceptance APK is a production-mode Vite build so it
  // exercises the release web bundle, but it still talks to the host service
  // over 10.0.2.2. The exception is limited to development or the explicit
  // local diagnostics build; shipped production builds keep HTTPS-only
  // endpoint validation.
  const localHttp = (!import.meta.env.PROD || import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true") && parsed.protocol === "http:" &&
    (/^(localhost|127\.0\.0\.1|10\.0\.2\.2)$/i.test(hostname) || isPrivateIpv4);
  if ((!/^https:$/i.test(parsed.protocol) && !localHttp) || parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error("账号服务地址必须使用 HTTPS；本地联调可使用 localhost、10.0.2.2 或局域网私有 IP");
  }
  return normalized;
}

// ----------------------------------------------------------------- 请求
async function request<T>(
  path: string,
  body?: unknown,
  token?: string,
  method: "GET" | "POST" = "POST",
  timeoutMs = 12_000,
  validate?: (payload: Record<string, unknown>) => boolean,
): Promise<ApiResult<T>> {
  const endpoint = getEndpoint();
  return requestAccount<T>(endpoint, path, body, token, method, timeoutMs, validate);
}

// ----------------------------------------------------------------- 接口
export type AuthPayload = { user: AuthUser; token: string; action: "login" | "registered" };

export const authApi = {
  sendCode: (channel: Channel, target: string, scene: "login" | "register" = "login") =>
    request<{ target: string; expiresIn: number; devCode?: string }>("/api/auth/code/send", {
      channel,
      target,
      scene,
    }),

  emailRegister: (email: string, password: string) =>
    request<AuthPayload>("/api/auth/email/register", {
      email: normalizeEmail(email),
      password,
    }, undefined, "POST", 12_000, validAuthPayloadResponse),

  emailLogin: (email: string, password: string) =>
    request<AuthPayload>("/api/auth/email/login", {
      email: normalizeEmail(email),
      password,
    }, undefined, "POST", 12_000, validAuthPayloadResponse),

  codeLogin: (channel: Channel, target: string, code: string) =>
    request<AuthPayload>("/api/auth/code/login", {
      channel,
      target: channel === "sms" ? normalizePhone(target) : normalizeEmail(target),
      code,
    }, undefined, "POST", 12_000, validAuthPayloadResponse),

  me: (token: string) => request<{ user: AuthUser }>("/api/me", undefined, token, "GET", 12_000, validUserResponse),

  health: () => request<ServiceHealth>("/healthz", undefined, undefined, "GET", 5_000, validHealthResponse),

  logout: (token: string) => request<{ action: string }>("/api/auth/logout", {}, token, "POST", 12_000, validLogoutResponse),

  generateTrip: (token: string, requestBody: unknown) =>
    request<{ content: string }>("/api/ai/generate", { request: requestBody }, token, "POST", 100_000, validAiResponse),
  agentPlan: (token: string, context: AgentContext) =>
    request<{ content: string }>("/api/ai/agent", { request: context }, token, "POST", 100_000, validAiResponse),

  sendPasswordResetCode: (email: string) =>
    request<{ email: string; expiresIn: number; devCode?: string }>("/api/auth/password/reset/send", { email: normalizeEmail(email) }, undefined, "POST", 12_000, validPasswordResetCodeResponse),

  resetPassword: (email: string, code: string, password: string) =>
    request<{ action: string }>("/api/auth/password/reset", { email: normalizeEmail(email), code, password }, undefined, "POST", 12_000, validPasswordResetResponse),
};

// ----------------------------------------------------------------- 登录态
export function loadSession(): AuthSession | null {
  if (isAndroidSecureStore()) return null;
  const s = loadJson<unknown>(SESSION_KEY, null);
  if (!validAuthSession(s)) return null;
  // 本地兜底过期：7 天
  if (Date.now() - (s.savedAt ?? 0) > 7 * 24 * 3600 * 1000) return null;
  return s;
}

function readLogoutTombstone() {
  try {
    const value = Number(localStorage.getItem(LOGOUT_TOMBSTONE_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function waitBeforeSecureRetry(attempt: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
}

export function useAuth() {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [ready, setReady] = useState(!isAndroidSecureStore());
  const [storageError, setStorageError] = useState<string | null>(null);
  const persistVersion = useRef(0);
  // Keystore calls cross the JS/native boundary. Queue them so a fast
  // login/logout sequence cannot let an older write finish after deletion and
  // resurrect a session on the next launch.
  const secureQueue = useRef<Promise<void>>(Promise.resolve());
  const queueSecure = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const operation = secureQueue.current.then(work);
    secureQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, []);

  const clearPersistedSession = useCallback(async () => {
    persistVersion.current += 1;
    setSession(null);
    const android = isAndroidSecureStore();
    if (android) {
      try { localStorage.setItem(LOGOUT_TOMBSTONE_KEY, String(Date.now())); } catch { /* best effort */ }
    }
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // The secure store remains authoritative on Android.
    }
    if (!android) return;
    await queueSecure(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const deleted = await deleteSecure(SESSION_KEY);
        // A failed delete must not resurrect the previous token on the next
        // launch. `null` is a present, invalid secure value, so startup will
        // refuse both it and any stale legacy localStorage copy.
        if (deleted || await writeSecure(SESSION_KEY, null)) {
          setStorageError(null);
          try {
            localStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(LOGOUT_TOMBSTONE_KEY);
          } catch { /* the secure tombstone remains authoritative */ }
          return true;
        }
        if (attempt < 2) await waitBeforeSecureRetry(attempt);
      }
      setStorageError("Android 安全存储不可用，登录会话可能无法保存。请检查设备锁屏状态和存储空间后重试。");
      return false;
    });
  }, [queueSecure]);

  const persist = useCallback((next: AuthSession | null) => {
    persistVersion.current += 1;
    setSession(next);
    if (next) {
      if (isAndroidSecureStore()) {
        void queueSecure(async () => {
          const saved = await writeSecure(SESSION_KEY, next);
          if (!saved) {
            setStorageError("Android 安全存储不可用，登录会话可能无法保存。请检查设备锁屏状态和存储空间后重试。");
          }
          if (saved) {
            setStorageError(null);
            try {
              localStorage.removeItem(SESSION_KEY);
              localStorage.removeItem(LOGOUT_TOMBSTONE_KEY);
            } catch { /* ignore */ }
          }
          return saved;
        });
      }
      else saveJson(SESSION_KEY, next);
    }
    else {
      void clearPersistedSession();
    }
  }, [clearPersistedSession, queueSecure]);

  useEffect(() => {
    if (!isAndroidSecureStore()) return;
    const startVersion = persistVersion.current;
    const logoutAt = readLogoutTombstone();
    let legacy: AuthSession | null = null;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      legacy = raw ? JSON.parse(raw) as AuthSession : null;
    } catch { /* ignore malformed legacy data */ }
    void readSecureEntry<AuthSession>(SESSION_KEY).then(async (secure) => {
      if (persistVersion.current !== startVersion) return;
      if (!secure.ok) {
        setStorageError("无法读取 Android 安全存储，暂不恢复登录会话。请检查设备锁屏状态后重试。");
        return;
      }
      setStorageError(null);
      const saved = secure.ok && secure.found ? secure.value : null;
      const candidate = secure.ok && !secure.found ? legacy : saved;
      if (!validAuthSession(candidate)) return;
      if (logoutAt && candidate.savedAt <= logoutAt) return;
      if (Date.now() - (candidate.savedAt ?? 0) > 7 * 24 * 3600 * 1000) return;
      if (persistVersion.current !== startVersion) return;
      setSession(candidate);
      if (logoutAt && candidate.savedAt > logoutAt) {
        try { localStorage.removeItem(LOGOUT_TOMBSTONE_KEY); } catch { /* best effort */ }
      }
      if (secure.ok && !secure.found && persistVersion.current === startVersion && await queueSecure(() => writeSecure(SESSION_KEY, candidate))) {
        try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      }
    }).finally(() => setReady(true));
  }, [queueSecure]);

  const adopt = useCallback(
    async (payload: AuthPayload) => {
      if (!validAuthPayloadResponse(payload as unknown as Record<string, unknown>)) {
        throw new Error("服务返回的登录信息无效，请稍后重试");
      }
      const next = { token: payload.token, user: payload.user, savedAt: Date.now() } satisfies AuthSession;
      const version = ++persistVersion.current;
      if (isAndroidSecureStore()) {
        const saved = await queueSecure(() => writeSecure(SESSION_KEY, next));
        if (persistVersion.current !== version) throw new Error("登录操作已取消");
        if (!saved) {
          setStorageError("Android 安全存储不可用，登录会话未保存。请检查设备锁屏状态和存储空间后重试。");
          throw new Error("Android 安全存储不可用，登录会话未保存，请重试");
        }
        try {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(LOGOUT_TOMBSTONE_KEY);
        } catch { /* secure storage remains authoritative */ }
      } else if (!saveJson(SESSION_KEY, next)) {
        throw new Error("设备存储不可用，登录会话未保存，请检查存储空间后重试");
      }
      if (persistVersion.current !== version) throw new Error("登录操作已取消");
      setStorageError(null);
      setSession(next);
    },
    [queueSecure]
  );

  const logout = useCallback(async () => {
    const token = session?.token;
    await clearPersistedSession();
    // Local logout is authoritative. A disconnected device must still leave
    // the account screen immediately; the server-side revocation is best
    // effort and can safely fail because the token is no longer persisted.
    if (token) await authApi.logout(token).catch(() => undefined);
  }, [clearPersistedSession, session?.token]);

  /** 启动时用本地 token 找后端核对一次；失败只清本地，不影响离线使用 */
  useEffect(() => {
    const token = session?.token;
    if (!token) return;
    let alive = true;
    (async () => {
      const r = await authApi.me(token);
      if (!alive) return;
      if (r.ok) {
        persist({ token, user: r.data.user, savedAt: Date.now() });
      } else if (r.code === "UNAUTHORIZED") {
        persist(null);
      }
      // NETWORK 之类的错误不动本地会话：离线时继续沿用缓存的用户信息
    })();
    return () => {
      alive = false;
    };
    // 仅在 token 变化时校验一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  return { user: session?.user ?? null, token: session?.token ?? null, adopt, logout, setSession: persist, ready, storageError };
}
