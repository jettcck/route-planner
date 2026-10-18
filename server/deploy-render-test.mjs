import assert from "node:assert/strict";
import fs from "node:fs";

const blueprint = fs.readFileSync("render.yaml", "utf8");

// 服务形态
assert.match(blueprint, /type:\s*web/);
assert.match(blueprint, /runtime:\s*node/);
assert.match(blueprint, /buildCommand:\s*npm ci --omit=dev/);
assert.match(blueprint, /startCommand:\s*node server\/auth-server\.mjs/);
assert.match(blueprint, /healthCheckPath:\s*\/readyz/);

// 正式账号数据不得放在免费实例上：免费计划的磁盘是临时的，实例重建即丢失。
assert.match(blueprint, /plan:\s*(starter|standard|pro)/);
assert.doesNotMatch(blueprint, /plan:\s*free/);

// 持久磁盘必须显式挂载，否则 server/data 仍是临时目录。
assert.match(blueprint, /mountPath:\s*\/opt\/render\/project\/src\/server\/data/);

// 单人版默认关闭公开注册 / 短信登录 / 自助改密，且必须由部署方显式开启。
assert.match(blueprint, /key:\s*AUTH_ALLOW_PUBLIC_SIGNUP[\s\S]*?sync:\s*false/);
assert.match(blueprint, /key:\s*AUTH_ALLOW_SMS_LOGIN[\s\S]*?sync:\s*false/);
assert.match(blueprint, /key:\s*AUTH_ALLOW_PASSWORD_RESET[\s\S]*?sync:\s*false/);

// 其余密钥与来源配置
assert.match(blueprint, /key:\s*AI_API_KEY[\s\S]*sync:\s*false/);
assert.match(blueprint, /key:\s*AUTH_HOST[\s\S]*value:\s*0\.0\.0\.0/);
assert.match(blueprint, /key:\s*AUTH_ORIGINS[\s\S]*tauri\.localhost/);

console.log("Render Blueprint test passed");
