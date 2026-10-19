// 单人私人版的正式包不带账号服务：VITE_AUTH_ENDPOINT 留空是**合法且默认**的配置。
// 保留本脚本只为一种情况——有人临时填了地址却写错协议或夹带凭据，
// 那种失误会在装机后才暴露成"登录页一直转圈"，应该在构建期就拦住。
const value = String(process.env.VITE_AUTH_ENDPOINT || "").trim();

if (!value) {
  console.log("No account service configured; building a local-only (single-user) frontend.");
  process.exit(0);
}

let parsed;
try {
  parsed = new URL(value);
} catch {
  console.error("VITE_AUTH_ENDPOINT must be a valid URL when set");
  process.exit(1);
}
if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
  console.error("VITE_AUTH_ENDPOINT must use HTTPS and cannot contain credentials, query parameters, or fragments");
  process.exit(1);
}
console.log(`Production frontend endpoint OK: ${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`);
