import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.resolve("server", "config-check.mjs");
const frontendScript = path.resolve("server", "frontend-config-check.mjs");
const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  AI_API_KEY: "test-key",
  AI_ENDPOINT: "https://api.example.com/chat/completions",
  AI_MODEL: "test-model",
};

function run(name, origins, expected, extra = {}) {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...baseEnv, AUTH_ORIGINS: origins, ...extra },
  });
  const passed = (result.status ?? 1) === expected;
  if (!passed) {
    throw new Error(`${name} expected exit ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  }
}

function runFrontend(name, endpoint, expected) {
  const result = spawnSync(process.execPath, [frontendScript], {
    encoding: "utf8",
    env: { ...process.env, VITE_AUTH_ENDPOINT: endpoint },
  });
  const passed = (result.status ?? 1) === expected;
  if (!passed) {
    throw new Error(`${name} expected exit ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  }
}

run("Tauri app origin is allowed", "https://app.example.com,http://tauri.localhost", 0);
run("CORS wildcard is rejected", "*", 1);
run("普通 localhost origin is rejected", "https://app.example.com,http://localhost", 1);
run("origin path is rejected", "https://app.example.com/path", 1);
run("AI endpoint credentials are rejected", "https://app.example.com", 1, {
  AI_ENDPOINT: "https://user:password@api.example.com/chat/completions",
});
run("AI endpoint query parameters are rejected", "https://app.example.com", 1, {
  AI_ENDPOINT: "https://api.example.com/chat/completions?tenant=demo",
});
// 账号服务已从发布链路移除：端点留空是合法配置，正式包按纯本机构建。
// 这条用例同时是回归守卫——若有人把"必须配置端点"加回来，这里会立刻失败。
runFrontend("No account endpoint means a local-only build", "", 0);
runFrontend("Production frontend endpoint must use HTTPS", "http://account.example.com", 1);
runFrontend("Production frontend endpoint rejects credentials", "https://user:password@account.example.com", 1);
runFrontend("Production frontend endpoint rejects query parameters", "https://account.example.com/api?tenant=demo", 1);
runFrontend("Production frontend endpoint rejects fragments", "https://account.example.com/api#login", 1);
runFrontend("Production frontend endpoint accepts a clean HTTPS URL", "https://account.example.com/api", 0);
console.log("Production auth configuration tests passed");
