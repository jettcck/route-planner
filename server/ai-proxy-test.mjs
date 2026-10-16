import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
async function call(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}
function waitForStart(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Route auth service listening")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

let redirectProbeHits = 0;
const redirectProbe = http.createServer((req, res) => {
  redirectProbeHits += 1;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }));
});
const redirectProbePort = await listen(redirectProbe);
const upstream = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const request = JSON.parse(text);
  const prompt = request.messages?.[1]?.content ? JSON.parse(request.messages[1].content) : {};
  if (prompt.destination === "重定向测试") {
    res.writeHead(302, { Location: `http://127.0.0.1:${redirectProbePort}/capture` });
    res.end();
    return;
  }
  const trip = { title: "测试行程", destination: "上海", overview: "代理测试", days: [{ date: "2026-10-01", theme: "城市漫步", activities: [{ time: "09:00", title: "外滩", detail: "测试活动", location: "外滩", estimatedCost: 0, durationMinutes: 60, type: "景点" }] }], tips: ["测试"] };
  if (prompt.instruction) {
    const proposal = { summary: "建议稍后出发", warnings: [], actions: [{ type: "reschedule_activity", day: 0, index: 0, time: "10:00", reason: "避开早高峰" }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    return;
  }
  const valid = req.headers.authorization === "Bearer test-ai-key" && request.model === "test-model";
  res.writeHead(valid ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(valid ? { choices: [{ message: { content: JSON.stringify(trip) } }] } : { error: { message: "bad credentials" } }));
});
const upstreamPort = await listen(upstream);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-auth-test-"));
const authPort = 18_000 + Math.floor(Math.random() * 1_000);
const child = spawn(process.execPath, [path.resolve("server/auth-server.mjs")], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", AUTH_HOST: "127.0.0.1", AUTH_PORT: String(authPort), AUTH_DATA_DIR: dataDir, AUTH_ORIGINS: "http://127.0.0.1:1420", AI_API_KEY: "test-ai-key", AI_ENDPOINT: `http://127.0.0.1:${upstreamPort}/chat/completions`, AI_MODEL: "test-model" }, stdio: ["ignore", "pipe", "pipe"] });
try {
  await waitForStart(child);
  const base = `http://127.0.0.1:${authPort}`;
  const email = `999${Date.now().toString().slice(-8)}@qq.com`;
  const register = await call(`${base}/api/auth/email/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "TestPass123" }) });
  if (register.response.status !== 200 || !register.body.token) throw new Error("register failed");
  const requestBody = { destination: "上海", startDate: "2026-10-01", days: 1, travelers: 1, budget: 1000, pace: "适中", interests: ["城市漫步"], notes: "" };
  const generated = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: requestBody }) });
  if (generated.response.status !== 200 || JSON.parse(generated.body.content).destination !== "上海") throw new Error(`AI proxy failed: ${generated.response.status}`);
  const agentContext = { instruction: "请检查行程", trip: { title: "测试行程", destination: "上海", overview: "代理测试", days: [{ date: "2026-10-01", theme: "城市漫步", activities: [{ time: "09:00", title: "外滩", detail: "测试活动", location: "外滩", estimatedCost: 0, durationMinutes: 60, type: "景点" }] }], tips: [] }, budget: 1000, travelers: 1, spent: 0, completed: [], reminders: [], weather: { source: "Open-Meteo", updatedAt: "2026-10-01T00:00:00Z", stale: false, days: [] } };
  const agent = await call(`${base}/api/ai/agent`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: agentContext }) });
  if (agent.response.status !== 200 || JSON.parse(agent.body.content).actions?.[0]?.type !== "reschedule_activity") throw new Error(`AI agent failed: ${agent.response.status}`);
  const invalidPace = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, pace: "极限" } }) });
  if (invalidPace.response.status !== 400 || invalidPace.body.code !== "INVALID_INPUT") throw new Error("AI pace validation failed");
  const invalidInterest = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, interests: [" "] } }) });
  if (invalidInterest.response.status !== 400 || invalidInterest.body.code !== "INVALID_INPUT") throw new Error("AI interest validation failed");
  const invalidDate = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, startDate: "2026-02-30" } }) });
  if (invalidDate.response.status !== 400 || invalidDate.body.code !== "INVALID_INPUT") throw new Error("AI calendar date validation failed");
  const invalidBudget = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, budget: -1 } }) });
  if (invalidBudget.response.status !== 400 || invalidBudget.body.code !== "INVALID_INPUT") throw new Error("AI budget validation failed");
  const longDestination = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, destination: "上海".repeat(14) } }) });
  if (longDestination.response.status !== 200) throw new Error("AI destination length compatibility failed");
  const redirect = await call(`${base}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${register.body.token}` }, body: JSON.stringify({ request: { ...requestBody, destination: "重定向测试" } }) });
  if (redirect.response.status !== 502 || redirect.body.code !== "AI_REDIRECT" || redirectProbeHits !== 0) throw new Error("AI redirect was not blocked safely");
  console.log("AI proxy end-to-end test passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => redirectProbe.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
