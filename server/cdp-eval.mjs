/**
 * 通过 CDP 在真机/模拟器的 WebView 里执行脚本，用于端到端验收。
 *
 * 用法：node server/cdp-eval.mjs "<JS 表达式>"
 * 依赖：adb forward tcp:9333 已指向 webview_devtools_remote_<pid>
 */
import fs from "node:fs";

const expression = process.argv[2];
if (!expression) {
  console.error("usage: node server/cdp-eval.mjs \"<js>\"");
  process.exit(2);
}

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((item) => item.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  const messageId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
}

ws.addEventListener("message", (event) => {
  const data = JSON.parse(typeof event.data === "string" ? event.data : "");
  const slot = pending.get(data.id);
  if (!slot) return;
  pending.delete(data.id);
  if (data.error) slot.reject(new Error(JSON.stringify(data.error)));
  else slot.resolve(data.result);
});

ws.addEventListener("open", async () => {
  try {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result.result.value, null, 2));
    }
  } catch (error) {
    console.error("ERROR:", error.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
