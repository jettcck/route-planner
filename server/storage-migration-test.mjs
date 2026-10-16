import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
function moduleUrl(file, replacements = []) {
  let compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const [specifier, url] of replacements) compiled = compiled.replaceAll(`"${specifier}"`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const keysUrl = moduleUrl("src/features/storage-keys.ts");
const storeUrl = moduleUrl("src/features/store.ts", [
  ["react", pathToFileURL(require.resolve("react")).href],
  ["./storage-keys", keysUrl],
]);
const { loadStored } = await import(storeUrl);
const { tripNamespace, legacyTripNamespace } = await import(keysUrl);
const { sanitizePackingItems } = await import(moduleUrl("src/features/packing.ts", [["./store", storeUrl]]));

const records = new Map();
let rejectWrites = false;
globalThis.localStorage = {
  getItem: (key) => records.get(key) ?? null,
  setItem(key, value) {
    if (rejectWrites) throw new Error("quota exceeded");
    records.set(key, value);
  },
  removeItem: (key) => records.delete(key),
};
try {
  const trip = { destination: "杭州|西湖", days: [{ date: "2026-10-08" }] };
  const key = `route-packing:${tripNamespace(trip)}`;
  const legacyKey = `route-packing:${legacyTripNamespace(trip)}`;
  const packing = [{ id: "passport", label: "身份证", category: "证件", checked: true, custom: true }];
  const cleaned = sanitizePackingItems(packing);
  records.set(legacyKey, JSON.stringify(packing));
  // No PackingView mount: the backup reader itself must recover the old copy.
  assert.deepEqual(loadStored(key, [], sanitizePackingItems), cleaned);
  assert.deepEqual(JSON.parse(records.get(key)), packing);
  assert.equal(records.has(legacyKey), false);

  // An explicit empty current list is authoritative; do not resurrect old items.
  records.set(legacyKey, JSON.stringify(packing));
  records.set(key, "[]");
  assert.deepEqual(loadStored(key, [], sanitizePackingItems), []);

  records.set(key, "{truncated");
  assert.deepEqual(loadStored(key, [], sanitizePackingItems), cleaned);
  assert.equal(records.has(legacyKey), false);

  records.delete(key);
  records.set(legacyKey, JSON.stringify(packing));
  rejectWrites = true;
  assert.deepEqual(loadStored(key, [], sanitizePackingItems), cleaned);
  assert.equal(records.has(legacyKey), true, "failed migration destroyed the only durable copy");
  assert.equal(records.has(key), false);
  rejectWrites = false;
  assert.deepEqual(loadStored(key, [], sanitizePackingItems), cleaned);
  assert.equal(records.has(legacyKey), false);
  assert.deepEqual(loadStored("route-packing:v2:%E0%A4|2026-10-08", [], sanitizePackingItems), []);
  console.log("Backup storage migration passed: legacy data, authoritative empty list, malformed current JSON and quota recovery");
} finally {
  delete globalThis.localStorage;
}
