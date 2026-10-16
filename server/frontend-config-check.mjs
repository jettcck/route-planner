const value = String(process.env.VITE_AUTH_ENDPOINT || "").trim();
if (!value) {
  console.error("VITE_AUTH_ENDPOINT is required for production builds (set it as a GitHub Actions repository variable)");
  process.exit(1);
}
let parsed;
try { parsed = new URL(value); } catch {
  console.error("VITE_AUTH_ENDPOINT must be a valid URL");
  process.exit(1);
}
if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
  console.error("VITE_AUTH_ENDPOINT must use HTTPS and cannot contain credentials, query parameters, or fragments");
  process.exit(1);
}
console.log(`Production frontend endpoint OK: ${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`);
