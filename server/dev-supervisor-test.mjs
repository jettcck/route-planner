import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("server/dev-all.mjs", "utf8");
assert.match(source, /function requestChildStop\(child\)/);
assert.match(source, /function forceStopChildTree\(child\)/);
assert.match(source, /taskkill.*\"\/PID\"/s);
assert.match(source, /\"\/T\", \"\/F\"/);
assert.match(source, /for \(const child of children\) requestChildStop\(child\)/);
assert.match(source, /for \(const child of children\) forceStopChildTree\(child\)/);
console.log("Development supervisor shutdown test passed");
