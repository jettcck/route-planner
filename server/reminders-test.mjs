import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/features/reminders.ts", "utf8")
  .replace('import type { Trip } from "../types";', "")
  .replace('import type { CurrentWeather, Weather } from "../weather";', "");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const trip = (dates) => ({
  title: "测试行程",
  destination: "上海",
  overview: "",
  days: dates.map((date) => ({ date, theme: "测试", activities: [] })),
  tips: [],
});

// Freeze the clock so the non-contiguous-date branch is deterministic.
const OriginalDate = globalThis.Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : ["2026-01-05T12:00:00"])); }
  static now() { return new OriginalDate("2026-01-05T12:00:00").getTime(); }
};
try {
  const interval = module.tripCountdown(trip(["2026-01-01", "2026-01-10"]));
  assert.equal(interval.status, "进行中");
  assert.equal(interval.label, "行程间隔");
  const scheduled = module.tripCountdown(trip(["2026-01-01", "2026-01-05", "2026-01-10"]));
  assert.equal(scheduled.label, "行程第 2 天");
} finally {
  globalThis.Date = OriginalDate;
}
console.log("Non-contiguous trip countdown test passed");
