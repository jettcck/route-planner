import fs from "node:fs";
import http from "node:http";
import ts from "typescript";

const source = fs.readFileSync("src/features/auth-request.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const client = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":');
    setTimeout(() => res.end("true}"), 300);
    return;
  }
  if (req.url === "/null") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("null");
    return;
  }
  if (req.url === "/large") {
    const value = "x".repeat(256 * 1024 + 1);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(value.length) });
    res.end(value);
    return;
  }
  if (req.url === "/wrong-shape") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true,"token":123}');
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"ok":true,"value":1}');
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
  const slow = await client.requestAccount(endpoint, "/slow", undefined, undefined, "GET", 60);
  if (slow.ok || slow.code !== "TIMEOUT") throw new Error("response-body timeout was not enforced");
  const nullPayload = await client.requestAccount(endpoint, "/null", undefined, undefined, "GET", 1_000);
  if (nullPayload.ok || nullPayload.code !== "BAD_RESPONSE") throw new Error("null response was accepted");
  const large = await client.requestAccount(endpoint, "/large", undefined, undefined, "GET", 1_000);
  if (large.ok || large.code !== "BAD_RESPONSE") throw new Error("oversized response was accepted");
  const valid = await client.requestAccount(endpoint, "/ok", undefined, undefined, "GET", 1_000);
  if (!valid.ok || valid.data.value !== 1) throw new Error("valid response was rejected");
  const wrongShape = await client.requestAccount(endpoint, "/wrong-shape", undefined, undefined, "GET", 1_000,
    (payload) => typeof payload.token === "string");
  if (wrongShape.ok || wrongShape.code !== "BAD_RESPONSE") throw new Error("response validator accepted an invalid payload");
  console.log("Auth client response-safety test passed");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
