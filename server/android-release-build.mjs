import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const androidRoot = path.join(root, "src-tauri", "gen", "android");
const targetRoot = path.join(root, "src-tauri", "target");
const apiLevel = String(process.env.ANDROID_API || "35");
// A local artifact is used for device and emulator acceptance, so it must
// match the CI release's ABI coverage by default. Developers can still set
// ANDROID_TARGETS=aarch64 for a faster ARM64-only iteration when needed.
const targetNames = String(process.env.ANDROID_TARGETS || "aarch64 armv7 i686 x86_64")
  .split(/[ ,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const targets = {
  aarch64: {
    triple: "aarch64-linux-android",
    abi: "arm64-v8a",
    compiler: `aarch64-linux-android${apiLevel}-clang.cmd`,
    cargoKey: "AARCH64_LINUX_ANDROID",
    ccKey: "aarch64_linux_android",
  },
  armv7: {
    triple: "armv7-linux-androideabi",
    abi: "armeabi-v7a",
    compiler: `armv7a-linux-androideabi${apiLevel}-clang.cmd`,
    cargoKey: "ARMV7_LINUX_ANDROIDEABI",
    ccKey: "armv7_linux_androideabi",
  },
  i686: {
    triple: "i686-linux-android",
    abi: "x86",
    compiler: `i686-linux-android${apiLevel}-clang.cmd`,
    cargoKey: "I686_LINUX_ANDROID",
    ccKey: "i686_linux_android",
  },
  x86_64: {
    triple: "x86_64-linux-android",
    abi: "x86_64",
    compiler: `x86_64-linux-android${apiLevel}-clang.cmd`,
    cargoKey: "X86_64_LINUX_ANDROID",
    ccKey: "x86_64_linux_android",
  },
};

if (process.platform !== "win32") {
  console.error("android:release:local is intended for Windows without Developer Mode; use the GitHub workflow on Linux/macOS.");
  process.exit(2);
}

const selected = targetNames.map((name) => {
  const target = targets[name];
  if (!target) throw new Error(`Unsupported Android target: ${name}`);
  return target;
});
if (!selected.length) throw new Error("ANDROID_TARGETS cannot be empty");

function run(command, args, env = process.env, cwd = root) {
  console.log(`> ${command} ${args.join(" ")}`);
  const isCmdScript = /\.(?:cmd|bat)$/i.test(command);
  const executable = isCmdScript ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = isCmdScript ? ["/d", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, env = process.env, cwd = root) {
  const isCmdScript = /\.(?:cmd|bat)$/i.test(command);
  const executable = isCmdScript ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = isCmdScript ? ["/d", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} 执行失败：${result.stderr || result.stdout || result.status}`);
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

// The local release wrapper is used for emulator acceptance and intentionally
// keeps the diagnostics route available. CI production builds do not set this
// flag, so the privileged test surface is removed from the shipped app.
const localBuildEnv = {
  ...process.env,
  VITE_ENABLE_ANDROID_DIAGNOSTICS: "true",
  // Keep local emulator acceptance deterministic: 10.0.2.2 resolves to the
  // Windows host from Android. An explicit value still wins for LAN testing.
  VITE_AUTH_ENDPOINT: process.env.VITE_AUTH_ENDPOINT?.trim() || "http://10.0.2.2:8787",
};
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], localBuildEnv);

const frontendIndex = path.join(root, "dist", "index.html");
if (!fs.existsSync(frontendIndex) || fs.statSync(frontendIndex).size === 0) {
  throw new Error(`前端 Release 资源不存在：${frontendIndex}`);
}

const ndk = process.env.ANDROID_NDK_ROOT || process.env.ANDROID_NDK_HOME ||
  (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "ndk", "27.2.12479018") : "");
if (!ndk || !fs.existsSync(ndk)) {
  throw new Error("找不到 Android NDK。请设置 ANDROID_NDK_ROOT，或安装 NDK 27.2.12479018。");
}
const llvmBin = path.join(ndk, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin");
if (!fs.existsSync(llvmBin)) throw new Error(`NDK LLVM 工具链不存在：${llvmBin}`);

const buildEnv = {
  ...process.env,
  // Keep the Gradle fallback-copy hook aligned with the ABI set compiled
  // above. Without this, a targeted fast build can accidentally restore stale
  // native libraries from a previous full build into the APK.
  ANDROID_TARGETS: targetNames.join(" "),
  ANDROID_NDK_ROOT: ndk,
  ANDROID_NDK_HOME: ndk,
  CARGO_TARGET_DIR: targetRoot,
  PATH: `${llvmBin};${process.env.PATH || ""}`,
};
for (const target of selected) {
  const compiler = path.join(llvmBin, target.compiler);
  if (!fs.existsSync(compiler)) throw new Error(`NDK 缺少编译器：${compiler}`);
  buildEnv[`CARGO_TARGET_${target.cargoKey}_LINKER`] = compiler;
  buildEnv[`CC_${target.ccKey}`] = compiler;
  buildEnv[`AR_${target.ccKey}`] = path.join(llvmBin, "llvm-ar.exe");
  // --release only selects Cargo optimization. Tauri still uses devUrl
  // unless custom-protocol is enabled, as the official CLI does.
  run("cargo.exe", ["build", "--manifest-path", "Cargo.toml", "--target", target.triple, "--release", "--features", "custom-protocol"], buildEnv, path.join(root, "src-tauri"));
}

const jniRoot = path.join(androidRoot, "app", "src", "main", "jniLibs");
for (const target of Object.values(targets)) {
  const destination = path.join(jniRoot, target.abi, "libroute_planner_lib.so");
  if (!selected.includes(target)) fs.rmSync(destination, { force: true });
}
for (const target of selected) {
  const source = path.join(targetRoot, target.triple, "release", "libroute_planner_lib.so");
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) throw new Error(`Rust 原生库不存在或为空：${source}`);
  const nativeBytes = fs.readFileSync(source);
  if (!nativeBytes.includes(Buffer.from("/index.html")) ||
      !nativeBytes.includes(Buffer.from("/assets/index-"))) {
    throw new Error(`Release 原生库缺少嵌入的前端资源：${source}`);
  }
  const destination = path.join(jniRoot, target.abi, "libroute_planner_lib.so");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const gradle = path.join(androidRoot, "gradlew.bat");
run(
  gradle,
  [":app:clean", ":app:assembleUniversalRelease", "--no-daemon", "--max-workers=1"],
  {
    ...buildEnv,
    ROUTE_ANDROID_SKIP_RUST_BUILD: "1",
    ROUTE_ANDROID_LOCAL_DEBUG_SIGNING: "1",
  },
  androidRoot,
);

const apk = path.join(androidRoot, "app", "build", "outputs", "apk", "universal", "release", "app-universal-release.apk");
if (!fs.existsSync(apk) || fs.statSync(apk).size === 0) throw new Error(`Release APK 未生成：${apk}`);
const sdkRoot = path.resolve(ndk, "..", "..");
const buildToolsRoot = path.join(sdkRoot, "build-tools");
const buildTools = fs.existsSync(buildToolsRoot)
  ? fs.readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]
  : null;
const apksigner = buildTools && path.join(buildToolsRoot, buildTools, "apksigner.bat");
if (!apksigner || !fs.existsSync(apksigner)) {
  throw new Error("找不到 Android SDK build-tools 的 apksigner，无法验证本地 APK 签名");
}
run(apksigner, ["verify", "--verbose", apk], process.env, root);

const aapt2 = buildTools && path.join(buildToolsRoot, buildTools, "aapt2.exe");
if (!aapt2 || !fs.existsSync(aapt2)) {
  throw new Error("找不到 Android SDK build-tools 的 aapt2，无法验证 APK 架构");
}
const badging = capture(aapt2, ["dump", "badging", apk], process.env, root);
const packageLine = badging.match(/package: name='([^']+)' versionCode='([^']+)'/);
if (!packageLine || packageLine[1] !== "com.luyou.planner") {
  throw new Error("本地 APK 包名校验失败");
}
const nativeCode = badging.match(/native-code:([^\r\n]*)/)?.[1] || "";
for (const target of selected) {
  if (!nativeCode.includes(`'${target.abi}'`)) {
    throw new Error(`本地 APK 缺少 ${target.abi} 原生库`);
  }
}
console.log(`APK metadata OK: ${packageLine[1]}, native ABIs: ${selected.map((target) => target.abi).join(", ")}`);
console.log(`Android local release APK ready (debug-signed for installation testing): ${apk}`);
