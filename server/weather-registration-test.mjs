import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/features/weather-registration.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const calls = [];
let enabled = false;
let now = 1_000_000;
let failNext = false;
const register = module.createWeatherRegistration({
  readStatus: async () => ({ notificationsEnabled: enabled }),
  isActive: () => true,
  now: () => now,
  schedule: async (immediate) => {
    calls.push(immediate);
    if (!enabled) throw new Error("notification permission disabled");
    if (failNext) {
      failNext = false;
      throw new Error("registration race");
    }
  },
});

// Permission is unavailable: the initial attempt may surface the permission
// prompt, but resume events must not repeatedly enqueue more work.
await register(true).catch(() => {});
await register(false);
if (calls.length !== 1 || calls[0] !== true) throw new Error("disabled permission was retried unexpectedly");

// A disabled -> enabled transition always gets a one-shot check.
enabled = true;
await register(false);
if (calls.length !== 2 || calls[1] !== true) throw new Error("permission restoration did not trigger an immediate check");
await register(false);
if (calls.length !== 3 || calls[2] !== false) throw new Error("focus retry bypassed the throttle");

// A failed registration remains eligible for an immediate retry after the
// activity returns, instead of consuming the retry window before it succeeds.
failNext = true;
await register(false).catch(() => {});
await register(false);
if (calls.at(-2) !== false || calls.at(-1) !== true) throw new Error("failed registration was not retried immediately");

now += 10 * 60 * 1000;
await register(false);
if (calls.at(-1) !== true) throw new Error("throttle window did not expire");

// The product's queue must cover the asynchronous status read as well as the
// write: several focus events all seeing a transition must enqueue only one
// immediate check.
enabled = false;
await register(false);
enabled = true;
const start = calls.length;
let queue = Promise.resolve();
const resumes = Array.from({ length: 3 }, () => {
  const task = queue.then(() => register(false));
  queue = task.catch(() => {});
  return task;
});
await Promise.all(resumes);
if (JSON.stringify(calls.slice(start)) !== "[true,false,false]") throw new Error("queued resume events replaced the immediate check repeatedly");

// A vendor can cancel the periodic request while leaving the durable trip
// configuration intact. The next foreground status read must repair it.
const repair = module.createWeatherRegistration({
  readStatus: async () => ({ notificationsEnabled: true, configured: true, periodic: [] }),
  schedule: async (immediate) => calls.push(immediate),
  isActive: () => true,
  now: () => 1_000,
});
await repair(false);
if (calls.at(-1) !== true) throw new Error("missing WorkManager task was not repaired immediately");

// Switching trips or logging out while native status is being read must not
// write a configuration belonging to the old trip.
let active = true;
let resolveStatus;
const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
let cancelledWrites = 0;
const cancelledRegister = module.createWeatherRegistration({
  readStatus: () => pendingStatus,
  isActive: () => active,
  schedule: async () => { cancelledWrites += 1; },
});
const pending = cancelledRegister(true);
active = false;
resolveStatus({ notificationsEnabled: true });
await pending;
if (cancelledWrites !== 0) throw new Error("cancelled trip registered stale work");

console.log("Weather registration recovery test passed");
