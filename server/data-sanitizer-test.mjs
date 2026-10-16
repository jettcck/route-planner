import fs from "node:fs";
import ts from "typescript";

async function loadModule(file) {
  const source = fs.readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const checkin = await loadModule("src/features/checkin.ts");
const reminders = await loadModule("src/features/reminders.ts");
const malicious = JSON.parse('{"__proto__":{"at":"2026-01-01T00:00:00.000Z","note":"bad"},"constructor":{"at":"2026-01-01T00:00:00.000Z","note":"bad"},"safe":{"at":"2026-01-01T00:00:00.000Z","note":"ok"}}');
const cleanedCheckIns = checkin.sanitizeCheckIns(malicious);
if (!cleanedCheckIns || Object.keys(cleanedCheckIns).length !== 1 || !cleanedCheckIns.safe) {
  throw new Error("check-in sanitizer accepted a prototype-pollution key");
}
if (Object.getPrototypeOf(cleanedCheckIns) !== null) {
  throw new Error("check-in sanitizer did not return a null-prototype map");
}
const collisionTrip = {
  destination: "测试",
  days: [{ date: "2026-01-01", activities: [
    { time: "09:00", title: "甲#乙", location: "丙", detail: "", estimatedCost: 0, durationMinutes: 30, type: "" },
    { time: "09:00", title: "甲", location: "乙#丙", detail: "", estimatedCost: 0, durationMinutes: 30, type: "" },
  ] }],
};
const firstKey = checkin.activityStableKey(collisionTrip, 0, 0);
const secondKey = checkin.activityStableKey(collisionTrip, 0, 1);
if (firstKey === secondKey || !firstKey.startsWith("v2:") || !secondKey.startsWith("v2:")) {
  throw new Error("collision-safe activity keys were not generated");
}
const longActivity = {
  destination: "测试",
  days: [{ date: "2026-01-01", activities: [{
    time: "09:00", title: "景".repeat(160), location: "地".repeat(160), detail: "", estimatedCost: 0, durationMinutes: 30, type: "",
  }] }],
};
const longKey = checkin.activityStableKey(longActivity, 0, 0);
if (longKey.length > 4_096 || !checkin.sanitizeCheckIns({ [longKey]: { at: "2026-01-01T00:00:00.000Z", note: "ok" } })?.[longKey]) {
  throw new Error("valid long activity key was rejected by the sanitizer");
}
const historical = checkin.activityHistoricalStableKey(collisionTrip, 0, 0);
if (!checkin.readCheckIn({ [historical]: { at: "2026-01-01T00:00:00.000Z", note: "legacy" } }, collisionTrip, 0, 0)) {
  throw new Error("historical check-in key was not readable");
}
const cleanedPrep = reminders.sanitizePrepState(JSON.parse('{"__proto__":true,"constructor":true,"safe":true}'));
if (!cleanedPrep || Object.keys(cleanedPrep).length !== 1 || cleanedPrep.safe !== true) {
  throw new Error("prep sanitizer accepted a prototype-pollution key");
}

console.log("Local data sanitizer test passed");
