import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// system-interaction.ts 刻意不依赖 Tauri / DOM，可以直接在 Node 里跑时序断言。
const source = fs.readFileSync("src/features/system-interaction.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1) 没发起交互时，任何返回都不该豁免——否则应用锁形同虚设
mod.resetSystemInteraction();
assert.equal(mod.consumeSystemInteraction(), false, "未发起交互时不得豁免");

// 2) 发起后紧接的那一次返回豁免
mod.resetSystemInteraction();
mod.beginSystemInteraction();
assert.equal(mod.consumeSystemInteraction(), true, "系统交互后的第一次返回应豁免");

// 3) **只豁免一次**：第二次必须回到正常锁定逻辑
//    这是本次修复的核心——早期 180 秒窗口让分享后 3 分钟都不锁。
assert.equal(mod.consumeSystemInteraction(), false, "令牌用掉后不得再次豁免");

// 4) 超时未消费则失效（用户发起分享后真的走了）
mod.resetSystemInteraction();
mod.beginSystemInteraction(20);
await sleep(40);
assert.equal(mod.consumeSystemInteraction(), false, "过期令牌不得豁免");

// 5) 长时间窗口 + 立即消费仍然有效（正常分享路径）
mod.resetSystemInteraction();
mod.beginSystemInteraction(120_000);
assert.equal(mod.consumeSystemInteraction(), true, "正常窗口内应豁免");

// 6) 令牌被消费后，新的 begin 能重新授权
mod.resetSystemInteraction();
mod.beginSystemInteraction();
assert.equal(mod.consumeSystemInteraction(), true);
mod.beginSystemInteraction();
assert.equal(mod.consumeSystemInteraction(), true, "每次分享都应重新获得一次豁免");

console.log("System interaction token test passed: one-shot exemption, expiry, and re-arm verified");
