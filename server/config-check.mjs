const env = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const port = Number(process.env.AUTH_PORT || 8787);
const origins = String(process.env.AUTH_ORIGINS || "http://localhost:1420,http://127.0.0.1:1420")
  .split(",").map((value) => value.trim()).filter(Boolean);
const endpoint = String(process.env.AI_ENDPOINT || "https://api.deepseek.com/chat/completions").trim();
const apiKey = String(process.env.AI_API_KEY || "").trim();
const model = String(process.env.AI_MODEL || "deepseek-chat").trim();
const TAURI_APP_ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost"]);
const errors = [];

if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("AUTH_PORT 必须是 1~65535 的整数");
if (origins.includes("*")) errors.push("AUTH_ORIGINS 不能使用通配符 *，请填写精确来源");
try {
  const parsed = new URL(endpoint);
  const localHttp = parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash) {
    errors.push("AI_ENDPOINT 必须使用 HTTPS，且不能包含账号、密码、查询参数或片段");
  }
} catch { errors.push("AI_ENDPOINT 不是有效 URL"); }
if (env === "production") {
  if (!apiKey) errors.push("生产环境必须配置 AI_API_KEY");
  if (!model) errors.push("生产环境必须配置 AI_MODEL");
  if (!origins.length || origins.some((origin) => {
    if (TAURI_APP_ORIGINS.has(origin)) return false;
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== "https:" || parsed.origin !== origin || parsed.pathname !== "/" ||
        Boolean(parsed.search || parsed.hash || parsed.username || parsed.password) || /localhost|127\.0\.0\.1/i.test(parsed.hostname);
    } catch {
      return true;
    }
  })) {
    errors.push("生产环境 AUTH_ORIGINS 必须是实际 HTTPS 来源或精确的 Tauri 应用来源，不能使用 * 或本机地址");
  }
}

if (errors.length) {
  console.error("Auth service configuration failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Auth service configuration OK (${env})`);
console.log(`- port: ${port}`);
console.log(`- origins: ${origins.join(", ") || "(none)"}`);
console.log(`- AI: ${apiKey ? `configured (${model})` : "not configured (AI generation unavailable)"}`);
