import assert from "node:assert/strict";
import fs from "node:fs";

const blueprint = fs.readFileSync("render.yaml", "utf8");
assert.match(blueprint, /type:\s*web/);
assert.match(blueprint, /runtime:\s*node/);
assert.match(blueprint, /plan:\s*free/);
assert.match(blueprint, /buildCommand:\s*npm ci --omit=dev/);
assert.match(blueprint, /startCommand:\s*node server\/auth-server\.mjs/);
assert.match(blueprint, /healthCheckPath:\s*\/readyz/);
assert.match(blueprint, /key:\s*AI_API_KEY[\s\S]*sync:\s*false/);
assert.match(blueprint, /key:\s*AUTH_HOST[\s\S]*value:\s*0\.0\.0\.0/);
assert.match(blueprint, /key:\s*AUTH_ORIGINS[\s\S]*tauri\.localhost/);
console.log("Render Blueprint test passed");
