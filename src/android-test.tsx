import { useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./android-test.css";

type UpdateInfo = { version: string; url: string; name: string };
type LogEntry = { time: string; name: string; ok: boolean; detail: string };

function describe(value: unknown) {
  if (value === undefined) return "完成";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default function AndroidTestPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [secureKey] = useState(() => `diagnostic-${Date.now()}`);
  const runtime = useMemo(() => ({
    tauri: isTauri(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    online: navigator.onLine,
    path: window.location.pathname,
  }), []);

  async function run<T>(name: string, task: () => Promise<T>) {
    setRunning(name);
    const started = Date.now();
    try {
      const result = await task();
      setLogs((current) => [{ time: new Date().toLocaleTimeString(), name, ok: true, detail: `${describe(result)}\n耗时 ${Date.now() - started}ms` }, ...current]);
      return result;
    } catch (error) {
      setLogs((current) => [{ time: new Date().toLocaleTimeString(), name, ok: false, detail: `${error instanceof Error ? error.message : String(error)}\n耗时 ${Date.now() - started}ms` }, ...current]);
      return undefined;
    } finally {
      setRunning(null);
    }
  }

  function button(name: string, action: () => Promise<unknown>, label = name) {
    return <button type="button" disabled={Boolean(running)} onClick={() => void run(name, action)}>{running === name ? "测试中…" : label}</button>;
  }

  async function checkUpdate() {
    // Never keep a previously discovered APK installable after a failed or
    // interrupted refresh.
    setUpdate(null);
    const result = await invoke<UpdateInfo | null>("plugin:android-updater|check");
    setUpdate(result ?? null);
    return result;
  }

  return (
    <main className="android-test-page">
      <header className="android-test-header">
        <div><span className="android-test-badge">ROUTE / ANDROID DIAGNOSTICS</span><h1>安卓端原生能力测试台</h1><p>此页面用于真机或 Android 模拟器验收。每项测试都只在点击后执行，并记录原生桥接返回结果。</p></div>
        <a href="/">返回应用</a>
      </header>

      <section className="android-test-runtime">
        <b>运行环境</b>
        <span className={runtime.tauri ? "good" : "warn"}>{runtime.tauri ? "Tauri 原生容器" : "普通浏览器（原生插件不可用）"}</span>
        <code>{runtime.platform} · {runtime.online ? "联网" : "离线"}</code>
        <small>{runtime.userAgent}</small>
      </section>

      <div className="android-test-grid">
        <section className="android-test-card"><h2>安全存储</h2><p>验证 Android Keystore 加密写入、读取和删除。</p>{button("安全存储", async () => { await invoke("plugin:secure-storage|secure_set", { key: secureKey, value: JSON.stringify({ ok: true, at: Date.now() }) }); const value = await invoke("plugin:secure-storage|secure_get", { key: secureKey }); await invoke("plugin:secure-storage|secure_delete", { key: secureKey }); return value; }, "运行读写删除")}</section>
        <section className="android-test-card"><h2>地图应用</h2><p>检测高德、百度、腾讯地图，并可打开高德测试深链。</p>{button("地图应用检测", () => invoke("plugin:map-launcher|map_apps"), "检测已安装地图")}{button("打开地图", () => invoke("plugin:map-launcher|open_map", { packageName: "com.autonavi.minimap", url: "androidamap://keywordNavi?sourceApplication=luyou&keyword=天安门&style=2" }), "打开高德测试点")}</section>
        <section className="android-test-card"><h2>文件分享</h2><p>生成小型文本文件并打开 Android 系统分享面板。</p>{button("文件分享", () => invoke("plugin:file-share|share_text", { filename: "途迹安卓测试.txt", text: `途迹原生分享测试\n${new Date().toLocaleString()}`, fileType: "text/plain" }), "打开分享面板")}</section>
        <section className="android-test-card"><h2>通知</h2><p>约 30 秒后发送一条本地通知，验证通知权限与渠道；不会覆盖已有行程提醒。</p>{button("本地通知", () => invoke("plugin:notifications|schedule_notification", { title: "途迹测试通知", body: "安卓原生通知链路正常。", atMillis: Date.now() + 30_000, replaceExisting: false }), "安排 30 秒通知")}</section>
        <section className="android-test-card"><h2>定位权限</h2><p>验证 Android 运行时定位权限，随后可回到首页测试当前位置天气。</p>{button("定位状态", () => invoke("plugin:location-permission|location_permission_status"), "读取权限状态")}{button("请求定位", () => invoke("plugin:location-permission|request_location_permission"), "请求系统权限")}</section>
        <section className="android-test-card"><h2>后台天气监测</h2><p>读取当前 WorkManager 状态，或注册一条独立的测试配置；此页面不会加载真实行程。</p>{button("后台天气状态", () => invoke("plugin:weather-background|weather_monitor_status"), "读取任务状态")}{button("后台天气", () => invoke("plugin:weather-background|schedule_weather_monitor", { destination: "北京", dates: [new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)] }), "注册测试任务")}{button("取消后台天气", () => invoke("plugin:weather-background|cancel_weather_monitor"), "取消测试任务")}</section>
        <section className="android-test-card"><h2>应用更新</h2><p>检查 GitHub Release 最新 APK；安装仍需 Android 系统确认。</p><div className="android-test-actions">{button("Android 更新检查", checkUpdate, "检查最新版本")}{update ? button("Android 更新安装", () => invoke("plugin:android-updater|install", update), `安装 v${update.version}`) : null}</div>{update ? <small className="update-result">发现：{update.name}</small> : null}</section>
      </div>

      <section className="android-test-log"><div className="android-test-log-head"><h2>测试日志</h2><button type="button" onClick={() => setLogs([])} disabled={!logs.length}>清空</button></div>{logs.length ? logs.map((entry, index) => <article key={`${entry.time}-${index}`} className={entry.ok ? "ok" : "fail"}><div><b>{entry.ok ? "通过" : "失败"} · {entry.name}</b><time>{entry.time}</time></div><pre>{entry.detail}</pre></article>) : <p>尚未执行测试。建议按“安全存储 → 定位权限 → 通知 → 分享 → 后台天气 → 更新”顺序验收。</p>}</section>
    </main>
  );
}
