/**
 * 应用锁：锁屏与设置项。
 *
 * 锁定状态由 App 持有（sessionLocked），本组件只负责：
 *  - 设置里开关锁 / 修改口令
 *  - 冷启动或从后台恢复时要求解锁
 *
 * 注意：锁屏是"盖在应用上的一层"，不会卸载 React 树，
 * 因此后台恢复后原来的页面状态（当前标签、滚动位置）都还在。
 */
import { useEffect, useState } from "react";
import { Delete, Lock, ShieldCheck } from "lucide-react";
import { clearFails, disableLock, readFails, recordFail, setLockPin, validPin, verifyPin } from "./app-lock";

/* ------------------------------------------------------------------ 锁屏 */

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockUntil, setLockUntil] = useState(() => {
    const state = readFails();
    return state.until > Date.now() ? state.until : 0;
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lockUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [lockUntil]);

  useEffect(() => {
    if (lockUntil && now >= lockUntil) {
      setLockUntil(0);
      setError("");
    }
  }, [now, lockUntil]);

  const remaining = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;

  async function submit(value: string) {
    if (busy || remaining) return;
    setBusy(true);
    setError("");
    try {
      if (await verifyPin(value)) {
        clearFails();
        onUnlock();
        return;
      }
      const locked = recordFail();
      setPin("");
      if (locked) {
        setLockUntil(Date.now() + locked * 1000);
        setError(`连续输错 5 次，请 ${locked} 秒后再试`);
      } else {
        setError("口令不正确");
      }
    } finally {
      setBusy(false);
    }
  }

  function press(key: string) {
    if (remaining) return;
    if (key === "del") {
      setPin((value) => value.slice(0, -1));
      return;
    }
    const next = (pin + key).slice(0, 8);
    setPin(next);
    // 4 位及以上自动尝试，减少一次按键；错误时用户能看到剩余输入。
    if (next.length === 4) void submit(next);
  }

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="应用已锁定">
      <div className="lock-card">
        <div className="lock-mark"><Lock size={22} /></div>
        <h2>途迹已锁定</h2>
        <p className="lock-hint">输入 4～8 位数字口令继续</p>
        <div className="lock-dots" aria-hidden="true">
          {Array.from({ length: Math.max(4, pin.length) }, (_, index) => (
            <i key={index} className={index < pin.length ? "filled" : ""} />
          ))}
        </div>
        {error ? <p className="lock-error" role="alert">{error}{remaining ? `（${remaining}s）` : ""}</p> : null}
        <div className="lock-pad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => (
            <button key={key} type="button" disabled={Boolean(remaining) || busy} onClick={() => press(key)}>
              {key}
            </button>
          ))}
          <span />
          <button type="button" disabled={Boolean(remaining) || busy} onClick={() => press("0")}>0</button>
          <button
            type="button"
            className="lock-del"
            aria-label="删除一位"
            disabled={Boolean(remaining) || busy}
            onClick={() => press("del")}
          >
            <Delete size={18} />
          </button>
        </div>
        <p className="lock-foot">数据仍保存在本机，锁定只阻止他人打开应用</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 设置项 */

type SettingsProps = {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
};

export function LockSettings({ enabled, onEnabledChange }: SettingsProps) {
  const [stage, setStage] = useState<"idle" | "set" | "verify" | "change">("idle");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [current, setCurrent] = useState("");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSet() {
    const error = validPin(pin);
    if (error) return setMessage({ type: "err", text: error });
    if (pin !== pin2) return setMessage({ type: "err", text: "两次输入的口令不一致" });
    setBusy(true);
    try {
      const ok = await setLockPin(pin);
      if (!ok) {
        setMessage({ type: "err", text: "口令保存失败，请检查设备存储空间后重试" });
        return;
      }
      onEnabledChange(true);
      setPin("");
      setPin2("");
      setStage("idle");
      setMessage({ type: "ok", text: "应用锁已开启，下次打开或从后台回来需要输入口令" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    try {
      if (!(await verifyPin(current))) {
        setMessage({ type: "err", text: "当前口令不正确" });
        return;
      }
      if (!(await disableLock())) {
        setMessage({ type: "err", text: "关闭失败，请稍后重试" });
        return;
      }
      onEnabledChange(false);
      setCurrent("");
      setStage("idle");
      setMessage({ type: "ok", text: "应用锁已关闭" });
    } finally {
      setBusy(false);
    }
  }

  async function handleChange() {
    if (!(await verifyPin(current))) {
      setMessage({ type: "err", text: "当前口令不正确" });
      return;
    }
    const error = validPin(pin);
    if (error) return setMessage({ type: "err", text: error });
    if (pin !== pin2) return setMessage({ type: "err", text: "两次输入的口令不一致" });
    setBusy(true);
    try {
      if (!(await setLockPin(pin))) {
        setMessage({ type: "err", text: "口令保存失败，请检查设备存储空间" });
        return;
      }
      setCurrent("");
      setPin("");
      setPin2("");
      setStage("idle");
      setMessage({ type: "ok", text: "口令已更新" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock-settings">
      <div className="lock-settings__row">
        <div>
          <strong>应用锁</strong>
          <small>4～8 位数字口令；只保存在本机，不联网</small>
        </div>
        <span className={`lock-badge${enabled ? " on" : ""}`}>{enabled ? "已开启" : "未开启"}</span>
      </div>

      {stage === "idle" ? (
        <div className="lock-settings__actions">
          {enabled ? (
            <>
              <button type="button" className="ghost-action" onClick={() => { setStage("change"); setMessage(null); }}>
                修改口令
              </button>
              <button type="button" className="ghost-action" onClick={() => { setStage("verify"); setMessage(null); }}>
                关闭应用锁
              </button>
            </>
          ) : (
            <button type="button" className="primary-action" onClick={() => { setStage("set"); setMessage(null); }}>
              设置口令
            </button>
          )}
        </div>
      ) : null}

      {stage === "set" || stage === "change" ? (
        <div className="lock-form">
          {stage === "change" ? (
            <label className="field">
              <span>当前口令</span>
              <input
                type="password"
                inputMode="numeric"
                value={current}
                autoComplete="off"
                maxLength={8}
                onChange={(event) => setCurrent(event.target.value.replace(/\D/g, ""))}
              />
            </label>
          ) : null}
          <label className="field">
            <span>新口令</span>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              autoComplete="new-password"
              maxLength={8}
              placeholder="4～8 位数字"
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            />
          </label>
          <label className="field">
            <span>再输一次</span>
            <input
              type="password"
              inputMode="numeric"
              value={pin2}
              autoComplete="new-password"
              maxLength={8}
              onChange={(event) => setPin2(event.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className="backup-actions">
            <button type="button" className="ghost-action" onClick={() => { setStage("idle"); setPin(""); setPin2(""); setCurrent(""); }}>
              取消
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void (stage === "change" ? handleChange() : handleSet())}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "verify" ? (
        <div className="lock-form">
          <label className="field">
            <span>当前口令</span>
            <input
              type="password"
              inputMode="numeric"
              value={current}
              autoComplete="off"
              maxLength={8}
              onChange={(event) => setCurrent(event.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className="backup-actions">
            <button type="button" className="ghost-action" onClick={() => { setStage("idle"); setCurrent(""); }}>
              取消
            </button>
            <button type="button" className="primary-action" disabled={busy} onClick={() => void handleDisable()}>
              {busy ? "处理中…" : "确认关闭"}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className={`backup-result ${message.type === "ok" ? "is-ok" : "is-err"}`} role={message.type === "err" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      <p className="lock-note">
        <ShieldCheck size={13} /> 应用锁只防"别人拿起你的手机翻看"。它不加密磁盘数据——
        设备被 root 或做过系统级备份时仍可能被读取。真要防这一点，请开启手机的"全盘/文件级加密"和屏幕锁。
      </p>
    </div>
  );
}
