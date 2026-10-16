import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const task = process.argv[2] || ":app:compileUniversalDebugKotlin";
const projectRoot = path.resolve(".");
const isWindows = process.platform === "win32";
let executionRoot = projectRoot;
const temporaryPaths = [];
if (task.includes("test")) {
  const configuredJava = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", isWindows ? "java.exe" : "java")
    : "java";
  const java = spawnSync(configuredJava, ["-version"], { encoding: "utf8" });
  const versionText = `${java.stdout || ""}\n${java.stderr || ""}`;
  const major = Number(versionText.match(/version\s+"(\d+)/)?.[1] || 0);
  // CI pins JDK 21. AGP 9 also runs these tests on JDK 25 and 26. Keep the
  // allow-list explicit so an unsupported runtime fails with an actionable
  // message instead of looking like a test-code failure.
  if (major && ![21, 25, 26].includes(major)) {
    console.error(`Android unit tests require JDK 21, 25, or 26; detected JDK ${major}. Set JAVA_HOME to a supported JDK and retry.`);
    process.exit(2);
  }
  // AGP's unit-test worker can lose classpath entries when the Windows project
  // path contains non-ASCII characters. A junction is insufficient because
  // Gradle resolves it back to the Chinese canonical path. Use a real ASCII
  // copy of the native project so JUnit receives ASCII classpath entries.
  if (process.platform === "win32" && /[^\x00-\x7F]/.test(projectRoot)) {
    const suffix = `route-planner-ascii-${process.pid}`;
    const rootFallback = path.join(process.env.SystemDrive || "C:\\", suffix);
    const sourceNativeRoot = path.join(projectRoot, "src-tauri");
    const copiedNativeRoot = path.join(rootFallback, "src-tauri");
    try {
      if (fs.existsSync(rootFallback)) fs.rmSync(rootFallback, { recursive: true, force: true });
      fs.mkdirSync(rootFallback, { recursive: true });
      fs.cpSync(sourceNativeRoot, copiedNativeRoot, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(sourceNativeRoot, source);
          if (!relative) return true;
          const segments = relative.split(path.sep);
          if (segments[0] === "target") return false;
          if (segments[0] === "gen" && segments[1] === "android" &&
            segments.slice(2).some((segment) => ["build", ".gradle", ".kotlin", ".tauri"].includes(segment))) return false;
          return true;
        },
      });
      temporaryPaths.push({ path: rootFallback, directory: true });
      executionRoot = rootFallback;
      console.warn(`Android unit tests are using a temporary ASCII project copy: ${rootFallback}`);
      if (!process.env.GRADLE_USER_HOME || /[^\x00-\x7F]/.test(process.env.GRADLE_USER_HOME)) {
        // Do not reuse a Gradle home whose canonical path contains the Chinese
        // user directory; Gradle may put it in the test worker classpath. A
        // real ASCII directory fixes worker bootstrap while reusing caches.
        const asciiGradleHome = process.platform === "win32"
          ? path.join(process.env.SystemDrive || "C:\\", "route-planner-gradle-cache")
          : path.join(os.tmpdir(), "route-planner-gradle-cache");
        fs.mkdirSync(asciiGradleHome, { recursive: true });
        process.env.GRADLE_USER_HOME = asciiGradleHome;
        console.warn(`Android unit tests are using an ASCII Gradle home: ${asciiGradleHome}`);
      }
    } catch (error) {
      try { fs.rmSync(rootFallback, { recursive: true, force: true }); } catch { /* best effort */ }
      console.error(`无法为中文路径创建 Android 单测临时 ASCII 工程副本：${error.message}`);
      process.exit(2);
    }
  }
}
const androidDir = path.resolve(executionRoot, "src-tauri", "gen", "android");
const wrapper = path.join(androidDir, isWindows ? "gradlew.bat" : "gradlew");
if (!fs.existsSync(wrapper)) {
  console.error(`Android Gradle wrapper not found: ${wrapper}`);
  cleanupLinks();
  process.exit(1);
}

const command = isWindows ? (process.env.ComSpec || "cmd.exe") : `./${path.basename(wrapper)}`;
const gradleArgs = [task, "--no-daemon"];
// Gradle can retain an UP-TO-DATE test compile record after a release clean
// while the Chinese-path output directory has been removed. That leaves the
// test worker with a class name but no .class file. Tests are small here, so
// force their compile/run tasks to execute and make the verifier deterministic.
if (task.includes("test")) gradleArgs.push("--rerun-tasks");
const args = isWindows
  ? ["/d", "/c", wrapper, ...gradleArgs]
  : gradleArgs;
const child = spawn(command, args, {
  cwd: androidDir,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`Android compile failed to start: ${error.message}`);
  cleanupLinks();
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (code === 0 && !signal && task.includes("test")) {
    try {
      reportUnitTests();
    } catch (error) {
      console.error(`Android test report validation failed: ${error.message}`);
      cleanupLinks();
      process.exit(1);
    }
  }
  cleanupLinks();
  if (signal) {
    console.error(`Android compile terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function reportUnitTests() {
  const results = path.join(androidDir, "app", "build", "test-results", task.split(":").at(-1));
  let total = 0;
  for (const name of fs.readdirSync(results).filter((name) => /^TEST-.*\.xml$/.test(name))) {
    const xml = fs.readFileSync(path.join(results, name), "utf8");
    const header = xml.match(/<testsuite\s[^>]*>/)?.[0];
    if (!header) throw new Error(`Invalid report: ${name}`);
    const count = (field) => {
      const match = header.match(new RegExp(`\\b${field}="(\\d+)"`));
      if (!match) throw new Error(`Missing ${field}: ${name}`);
      return Number(match[1]);
    };
    const tests = count("tests");
    const failures = count("failures");
    const errors = count("errors");
    const skipped = count("skipped");
    if (failures || errors || skipped) throw new Error(`Unsuccessful test suite: ${name}`);
    total += tests;
    console.log(`Android test suite ${name.slice(5, -4)}: ${tests} passed`);
  }
  if (!total) throw new Error("No Android unit tests were executed");
  console.log(`Android unit tests: ${total} passed (0 failures, 0 errors, 0 skipped)`);
}

function cleanupLinks() {
  for (const entry of temporaryPaths) {
    try {
      if (entry.directory) fs.rmSync(entry.path, { recursive: true, force: true });
      else fs.unlinkSync(entry.path);
    } catch { /* Best effort; Gradle may still hold a file briefly. */ }
  }
}
