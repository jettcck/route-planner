import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/weather.ts", "utf8")
  .replace('import { saveJson } from "./features/store";', "const saveJson = (key, value) => { globalThis.localStorage.setItem(key, JSON.stringify(value)); return true; };");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
};
const module = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const originalFetch = globalThis.fetch;
let forecastCalls = 0;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("geocoding-api.open-meteo.com")) {
    return new Response(JSON.stringify({ results: [{ latitude: 31.23, longitude: 121.47 }] }), { status: 200 });
  }
  forecastCalls += 1;
  if (forecastCalls === 1) {
    return new Response(JSON.stringify({
      current: { weather_code: 1, temperature_2m: 22, apparent_temperature: 22, precipitation: 0, wind_speed_10m: 5, time: "2026-10-08T10:00" },
      daily: { time: ["2026-10-09"], weather_code: [1], temperature_2m_min: [18], temperature_2m_max: [25], precipitation_probability_max: [10] },
    }), { status: 200 });
  }
  if (forecastCalls === 2) {
    throw new Error("device-location request failed");
  }
  if (forecastCalls === 3) {
    throw new Error("future-cache refresh unavailable");
  }
  return new Response(JSON.stringify({
    current: { weather_code: 2, temperature_2m: 21, apparent_temperature: 21, precipitation: 0, wind_speed_10m: 4, time: "2026-10-08T10:00" },
    daily: { time: ["2026-10-09"], weather_code: [2], temperature_2m_min: [17], temperature_2m_max: [24], precipitation_probability_max: [20] },
  }), { status: 200 });
};
try {
  const result = await module.getWeather("上海", ["2026-10-09"], { latitude: 39.9, longitude: 116.4 });
  assert.equal(result.source, "destination");
  assert.equal(result.days.length, 1);
  assert.match(result.message, /当前位置暂不可用/);
  assert.equal(result.current?.temperature, 22);
  assert.equal(module.saveWeatherBackup("上海", ["2026-10-09"], result.days), true);
  const backupKey = [...storage.keys()].find((key) => key.startsWith("route-weather-cache:v2:%E4%B8%8A%E6%B5%B7|2026-10-09|destination"));
  assert.ok(backupKey, "weather backup snapshot was not persisted");
  const snapshot = JSON.parse(storage.get(backupKey));
  assert.equal(snapshot.result.message, "来自行程备份的天气数据");
  assert.ok(snapshot.savedAt < Date.now() - 10 * 60 * 1000, "weather backup must be stale by design");
  storage.set(backupKey, JSON.stringify({ ...snapshot, savedAt: Date.now() + 24 * 60 * 60 * 1000 }));
  const futureResult = await module.getWeather("上海", ["2026-10-09"]);
  assert.equal(futureResult.stale, true, "future-dated weather cache must not be treated as fresh");
  module.saveWeatherBackup("A|B", ["2026-10-09"], result.days);
  module.saveWeatherBackup("A", ["2026-10-09"], result.days);
  const collisionKeys = [...storage.keys()].filter((key) => key.startsWith("route-weather-cache:v2:"));
  assert.equal(new Set(collisionKeys).size, collisionKeys.length, "encoded weather cache keys collided");
  assert.ok(collisionKeys.some((key) => key.includes("v2:a%7Cb|2026-10-09|destination")));
  assert.ok(collisionKeys.some((key) => key.includes("v2:a|2026-10-09|destination")));
  // Corrupt cache entries must be discarded instead of rendering arbitrary
  // dates or an unbounded number of weather rows.
  storage.set("route-weather-cache:v2:%E5%9D%8F%E6%95%B0%E6%8D%AE|2026-10-09|destination", JSON.stringify({
    savedAt: Date.now(),
    result: {
      days: Array.from({ length: 32 }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, "0")}`,
        label: "晴",
        summary: "晴",
      })),
      message: "坏缓存",
      source: "destination",
      updatedAt: new Date().toISOString(),
    },
  }));
  const malformed = await module.getWeather("坏数据", ["2026-10-09"]);
  assert.equal(malformed.days.length, 1, "malformed weather cache was rendered");
  console.log("Weather location fallback test passed");
} finally {
  globalThis.fetch = originalFetch;
}
