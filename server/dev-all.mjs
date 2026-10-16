import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
// Load the same development configuration in the supervisor itself before
// deriving the health URL and Vite endpoint. The child auth process also gets
// the file via --env-file-if-exists; loading here keeps both processes aligned
// when AUTH_PORT or VITE_AUTH_ENDPOINT is defined only in .env.
try {
  process.loadEnvFile?.(envFile);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const children = new Set();
let stopping = false;
const cliArgs = process.argv.slice(2);
function optionValue(name, fallback) {
  const inline = cliArgs.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = cliArgs.indexOf(name);
  return index >= 0 && cliArgs[index + 1] ? cliArgs[index + 1] : fallback;
}
const frontendPort = Number(optionValue("--port", process.env.VITE_PORT || 1420));
const safeFrontendPort = Number.isInteger(frontendPort) && frontendPort > 0 && frontendPort <= 65535 ? frontendPort : 1420;
const requestedAuthPort = Number(process.env.AUTH_PORT || 8787);
let authPort = Number.isInteger(requestedAuthPort) && requestedAuthPort > 0 && requestedAuthPort <= 65535
  ? requestedAuthPort
  : 8787;
let authHealthUrl = `http://127.0.0.1:${authPort}/healthz`;
const frontendOrigin = `http://127.0.0.1:${safeFrontendPort}`;
const alternateFrontendOrigin = `http://localhost:${safeFrontendPort}`;

async function authServiceAlreadyReady() {
  try {
    const origins = [frontendOrigin, alternateFrontendOrigin];
    const responses = await Promise.all(origins.map((origin) => fetch(authHealthUrl, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(700),
    })));
    return responses.every((response, index) =>
      response.ok && response.headers.get("access-control-allow-origin") === origins[index],
    );
  } catch {
    return false;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function start(command, args, name, env = process.env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    const reason = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
    console.error(`${name} stopped (${reason})`);
    stop(code && code !== 0 ? code : 1);
  });
  child.once("error", (error) => {
    if (stopping) return;
    console.error(`${name} failed to start: ${error.message}`);
    stop(1);
  });
  return child;
}

function requestChildStop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // On Windows, killing the Node supervisor does not always reap descendants
  // created by Vite or a package manager. Those orphaned listeners are the
  // usual cause of the next `npm run dev` attaching to a stale 1420/8787
  // process. Ask the child to stop gracefully first; the bounded shutdown
  // timer below escalates to taskkill for the entire process tree.
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
}

function forceStopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      try { child.kill(); } catch { /* best effort */ }
    });
    return;
  }
  try { child.kill("SIGKILL"); } catch { /* best effort */ }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) requestChildStop(child);
  const timer = setTimeout(() => {
    for (const child of children) forceStopChildTree(child);
    const exitTimer = setTimeout(() => process.exit(code), 500);
    exitTimer.unref();
  }, 2_000);
  timer.unref();
  if (!children.size) process.exit(code);
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
process.once("exit", () => {
  for (const child of children) {
    try { child.kill(); } catch { /* best effort */ }
  }
});

if (await authServiceAlreadyReady()) {
  console.log(`账号服务已在 ${authHealthUrl.replace(/\/healthz$/, "")} 运行，复用现有进程。`);
} else {
  // Leave AUTH_ORIGINS unset when the developer did not explicitly provide
  // one. The auth service then enables its guarded development policy for any
  // localhost/127.0.0.1 Vite port, so restarting with --port 1421 or reusing
  // an existing service cannot strand the login screen behind stale CORS.
  // A pre-existing development service from an older build may still expose
  // only the old Vite port. Do not bind a second service onto that occupied
  // port and leave the new frontend permanently offline; use a free local
  // port and inject it into Vite instead. Explicit AUTH_PORT remains the
  // requested first choice, but a stale process can still be bypassed.
  try {
    const occupied = await fetch(authHealthUrl, { signal: AbortSignal.timeout(300) });
    // Any HTTP response means that another process owns the port. A stale
    // account service may report 503 while it is not ready (for example when
    // production AI configuration is missing), but trying to bind over it
    // still fails and leaves Vite pointing at an unusable service.
    if (occupied.status > 0) {
      authPort = await findFreePort();
      authHealthUrl = `http://127.0.0.1:${authPort}/healthz`;
      console.warn(`已有账号服务未允许 ${frontendOrigin}，本次开发会话改用端口 ${authPort}。`);
    }
  } catch { /* the requested port is available */ }
  const authEnv = { ...process.env, AUTH_PORT: String(authPort) };
  start(process.execPath, ["--env-file-if-exists=.env", "server/auth-server.mjs"], "账号服务", authEnv);
}

// Spawn Vite through the current Node executable instead of `npm.cmd`. This
// works on Windows installations where libuv rejects direct .cmd spawning
// with EINVAL, and keeps the child attached to this supervisor for cleanup.
// A stale local VITE_AUTH_ENDPOINT in .env must follow the supervisor when it
// had to move the account service away from an occupied port. Preserve an
// explicitly configured HTTPS/remote endpoint, since that is an intentional
// integration target rather than a development default.
const configuredAuthEndpoint = String(process.env.VITE_AUTH_ENDPOINT || "").trim();
let useManagedAuthEndpoint = !configuredAuthEndpoint;
if (configuredAuthEndpoint) {
  try {
    const parsed = new URL(configuredAuthEndpoint);
    useManagedAuthEndpoint = parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      (parsed.port === "" || Number(parsed.port) === requestedAuthPort) &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/";
  } catch {
    // Let Vite surface an explicitly invalid endpoint instead of silently
    // replacing it with a local one.
  }
}
const frontendEnv = useManagedAuthEndpoint
  ? { ...process.env, VITE_AUTH_ENDPOINT: `http://127.0.0.1:${authPort}` }
  : process.env;
start(process.execPath, ["node_modules/vite/bin/vite.js", ...cliArgs], "Vite 前端", frontendEnv);
