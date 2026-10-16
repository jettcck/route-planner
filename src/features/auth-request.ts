export type ApiFailure = { code: string; message: string };
export type ApiResult<T> = { ok: true; data: T } | ({ ok: false } & ApiFailure);

const MAX_RESPONSE_BYTES = 256 * 1024;

/** The deadline covers headers AND the body; fetch resolves at headers only. */
export async function requestAccount<T>(
  endpoint: string,
  path: string,
  body?: unknown,
  token?: string,
  method: "GET" | "POST" = "POST",
  timeoutMs = 12_000,
  validate?: (payload: Record<string, unknown>) => boolean,
): Promise<ApiResult<T>> {
  if (!endpoint) return { ok: false, code: "CONFIG", message: "请先配置 HTTPS 账号服务地址" };
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutFailure = (): ApiResult<T> => ({
    ok: false, code: "TIMEOUT",
    message: path.startsWith("/api/ai/") ? "AI 服务响应超时，请稍后重试" : "请求超时，请稍后重试",
  });
  const badResponse = (): ApiResult<T> => ({ ok: false, code: "BAD_RESPONSE", message: "服务返回内容无法解析或格式无效" });
  const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);
  try {
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    const res = await fetch(new URL(path.replace(/^\/+/, ""), base), {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // Tokens must never follow redirects outside the configured service.
      redirect: "error",
    });
    let payload: unknown;
    try {
      if (Number(res.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) {
        await res.body?.cancel();
        return badResponse();
      }
      if (!res.body) return badResponse();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return badResponse();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return didTimeout ? timeoutFailure() : badResponse();
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return badResponse();
    const record = payload as Record<string, unknown>;
    if (!res.ok || record.ok !== true) {
      const retryAfter = Number(res.headers.get("Retry-After") || 0);
      const code = typeof record.code === "string" ? record.code : "UNKNOWN";
      const message = typeof record.message === "string" ? record.message.slice(0, 500) : "操作失败，请稍后再试";
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 && (code === "RATE_LIMITED" || code === "LOGIN_LOCKED")
        ? `（约 ${retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} 分钟` : `${Math.ceil(retryAfter)} 秒`}后可重试）` : "";
      return { ok: false, code, message: `${message}${wait}` };
    }
    if (validate && !validate(record)) return badResponse();
    return { ok: true, data: record as T };
  } catch {
    return didTimeout ? timeoutFailure() : { ok: false, code: "NETWORK", message: "连不上账号服务，请检查服务地址和网络连接" };
  } finally {
    clearTimeout(timer);
  }
}
