import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/features/storage-keys.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const keys = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const first = { destination: "A|B", days: [{ date: "2026-10-08" }] };
const second = { destination: "A", days: [{ date: "B|2026-10-08" }] };
const firstKey = keys.tripNamespace(first);
const secondKey = keys.tripNamespace(second);
assert.notEqual(firstKey, secondKey, "encoded trip namespaces collided");
assert.match(firstKey, /^v2:/);

const legacy = keys.legacyTripNamespace(first);
assert.equal(keys.legacyStorageKey(`route-ledger:${firstKey}`), `route-ledger:${legacy}`);
assert.equal(keys.legacyStorageKey("route-input"), null);
assert.equal(keys.legacyStorageKey("route-ledger:v2:%E0%A4|2026-10-08"), null);
console.log("Collision-safe trip storage key test passed");
