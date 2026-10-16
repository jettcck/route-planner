import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync("deploy/docker-compose.yml", "utf8");
const caddy = fs.readFileSync("deploy/Caddyfile.example", "utf8");
const env = fs.readFileSync("deploy/auth.env.example", "utf8");
const docs = fs.readFileSync("deploy/README.md", "utf8");
const render = fs.readFileSync("render.yaml", "utf8");

assert.match(compose, /image:\s+node:24-alpine/);
assert.match(compose, /image:\s+caddy:2-alpine/);
assert.match(compose, /- ".*80:80"/);
assert.match(compose, /- ".*443:443"/);
assert.match(compose, /condition:\s+service_healthy/);
assert.match(compose, /\.\/data:\/data/);
assert.match(caddy, /reverse_proxy auth:8787/);
assert.match(env, /NODE_ENV=production/);
assert.match(env, /AUTH_HOST=127\.0\.0\.1/);
assert.match(env, /AUTH_DATA_DIR=\/data/);
assert.match(env, /AI_API_KEY=$/m);
assert.doesNotMatch(env, /sk-[A-Za-z0-9]{12,}/);
assert.match(docs, /VITE_AUTH_ENDPOINT/);
assert.match(docs, /不要提交/);
assert.match(render, /type:\s*web/);
assert.match(render, /plan:\s*free/);
assert.match(render, /startCommand:\s*node server\/auth-server\.mjs/);
assert.match(render, /healthCheckPath:\s*\/readyz/);
assert.match(render, /key:\s*AI_API_KEY[\s\S]*sync:\s*false/);
console.log("Deployment template test passed: HTTPS proxy, health gate and persistent data are configured");
