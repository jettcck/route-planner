/**
 * 账号页：未登录显示登录/注册面板，已登录显示账号信息。
 * 作为「账号」视图挂进途迹主框架（侧边栏 + 顶部胶囊标签）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Mail,
  Server,
  ShieldCheck,
  RefreshCw,
  Smartphone,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  authApi,
  AUTH_ENDPOINT_CHANGED_EVENT,
  checkCode,
  checkEmail,
  checkPassword,
  checkPhone,
  DEFAULT_ENDPOINT,
  getEndpoint,
  normalizeEmail,
  normalizePhone,
  passwordStrength,
  setEndpoint,
  type AuthUser,
  type Channel,
} from "./auth";
import "./auth.css";

type Props = {
  user: AuthUser | null;
  ready: boolean;
  onLoggedIn: (payload: { user: AuthUser; token: string; action: "login" | "registered" }) => Promise<unknown>;
  onLogout: () => Promise<void>;
  onCheckUpdate: () => Promise<void>;
  storageError?: string | null;
};

const SMS_LOGIN_ENABLED = false;

/* ------------------------------------------------------------------ 小部件 */

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className={`auth-field${error ? " has-error" : ""}`}>
      <span className="auth-field__label">
        {label}
        {hint ? <em>{hint}</em> : null}
      </span>
      {children}
      <span className="auth-field__error" role="alert">
        {error ?? ""}
      </span>
    </label>
  );
}

function ServiceStatus() {
  const [state, setState] = useState<"checking" | "online" | "offline">("checking");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let attempts = 0;
    let requestGeneration = 0;
    const check = () => {
      if (!alive) return;
      const generation = ++requestGeneration;
      setState("checking");
      void authApi.health().then((result) => {
        // A manual refresh or endpoint change can start a second request
        // before the first one returns. Ignore the stale response so an old
        // service status cannot overwrite the current endpoint's result.
        if (!alive || generation !== requestGeneration) return;
        if (result.ok) {
          setState("online");
          setAiConfigured(result.data.aiConfigured);
          attempts = 0;
          return;
        }
        setState("offline");
        // Dev supervisors and mobile networks can become ready just after
        // the page. Retry briefly so a transient startup/network race does
        // not leave the login screen stuck offline forever.
        if (attempts < 4) {
          attempts += 1;
          timer = window.setTimeout(check, Math.min(5_000, attempts * 1_000));
        }
      }).catch(() => {
        if (!alive || generation !== requestGeneration) return;
        setState("offline");
        if (attempts < 4) {
          attempts += 1;
          timer = window.setTimeout(check, Math.min(5_000, attempts * 1_000));
        }
      });
    };
    const retryWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer !== undefined) window.clearTimeout(timer);
      attempts = 0;
      check();
    };
    window.addEventListener("online", retryWhenVisible);
    document.addEventListener("visibilitychange", retryWhenVisible);
    window.addEventListener(AUTH_ENDPOINT_CHANGED_EVENT, retryWhenVisible);
    check();
    return () => {
      alive = false;
      requestGeneration += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("online", retryWhenVisible);
      document.removeEventListener("visibilitychange", retryWhenVisible);
      window.removeEventListener(AUTH_ENDPOINT_CHANGED_EVENT, retryWhenVisible);
    };
  }, [refresh]);

  const label = state === "checking"
    ? "正在检查账号服务…"
    : state === "online"
      ? aiConfigured ? "账号服务在线 · AI 已配置" : "账号服务在线 · AI 待配置"
      : "账号服务连接失败";
  return (
    <button type="button" className={`auth-service-status ${state}`} onClick={() => setRefresh((value) => value + 1)} aria-label="重新检查账号服务">
      {state === "offline" ? <WifiOff size={13} /> : <Wifi size={13} />}
      <span>{label}</span>
      {state !== "checking" ? <small>点击刷新</small> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ 登录面板 */

function LoginPanel({ onLoggedIn }: Pick<Props, "onLoggedIn">) {
  const [channel, setChannel] = useState<Channel>("email");
  const [emailMode, setEmailMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [legalDoc, setLegalDoc] = useState<"terms" | "privacy" | null>(null);
  const [endpointDraft, setEndpointDraft] = useState(getEndpoint());
  const codeInput = useRef<HTMLInputElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetCountdown, setResetCountdown] = useState(0);
  const [showResetPassword, setShowResetPassword] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  useEffect(() => {
    if (resetCountdown <= 0) return;
    const t = setTimeout(() => setResetCountdown((value) => value - 1), 1000);
    return () => clearTimeout(t);
  }, [resetCountdown]);

  useEffect(() => {
    if (!legalDoc) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLegalDoc(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [legalDoc]);

  const setError = (key: string, message: string) =>
    setErrors((prev) => ({ ...prev, [key]: message }));

  /* ---------------- 发验证码 ---------------- */
  async function sendCode() {
    const phoneError = checkPhone(phone);
    setError("phone", phoneError);
    if (phoneError) return;
    setBusy(true);
    setNotice(null);
    const r = await authApi.sendCode("sms", phone);
    setBusy(false);
    if (!r.ok) {
      setNotice({ type: "err", text: r.message });
      return;
    }
    const expiresIn = Number(r.data.expiresIn);
    setCountdown(Number.isFinite(expiresIn) ? Math.min(300, Math.max(60, Math.floor(expiresIn))) : 60);
    codeInput.current?.focus();
    const isLocalEndpoint = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(getEndpoint());
    if (r.data.devCode && isLocalEndpoint) {
      setCode(r.data.devCode); // 本地开发便利；接入真实短信网关后删除
      setNotice({ type: "ok", text: `本地开发模式：验证码 ${r.data.devCode}（5 分钟内有效）` });
    } else {
      setNotice({ type: "ok", text: "验证码已发送" });
    }
  }

  /* ---------------- 邮箱提交 ---------------- */
  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    const emailError = checkEmail(email);
    const passwordError = checkPassword(password);
    setError("email", emailError);
    setError("password", passwordError);
    if (emailError || passwordError) return;
    if (isRegister && !agreed) {
      setNotice({ type: "err", text: "请先阅读并同意用户协议与隐私政策" });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const r =
        emailMode === "register"
          ? await authApi.emailRegister(email, password)
          : await authApi.emailLogin(email, password);
      if (!r.ok) {
        if (r.code === "EMAIL_TAKEN") setError("email", r.message);
        else if (r.code === "BAD_CREDENTIALS") setError("password", r.message);
        else setNotice({ type: "err", text: r.message });
        return;
      }
      await onLoggedIn(r.data);
    } catch (reason) {
      setNotice({ type: "err", text: reason instanceof Error ? reason.message : "登录会话保存失败，请重试" });
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 手机号提交 ---------------- */
  async function submitPhone(event: React.FormEvent) {
    event.preventDefault();
    const phoneError = checkPhone(phone);
    const codeError = checkCode(code);
    setError("phone", phoneError);
    setError("code", codeError);
    if (phoneError || codeError) return;
    if (!agreed) {
      setNotice({ type: "err", text: "请先阅读并同意用户协议与隐私政策" });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const r = await authApi.codeLogin("sms", phone, code);
      if (!r.ok) {
        if (r.code === "CODE_INVALID") setError("code", r.message);
        else setNotice({ type: "err", text: r.message });
        return;
      }
      await onLoggedIn(r.data);
    } catch (reason) {
      setNotice({ type: "err", text: reason instanceof Error ? reason.message : "登录会话保存失败，请重试" });
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordResetCode() {
    const emailError = checkEmail(resetEmail);
    if (emailError) { setNotice({ type: "err", text: emailError }); return; }
    setBusy(true); setNotice(null);
    const result = await authApi.sendPasswordResetCode(resetEmail);
    setBusy(false);
    if (!result.ok) { setNotice({ type: "err", text: result.message }); return; }
    setResetCountdown(Math.min(600, Math.max(60, Math.floor(result.data.expiresIn))));
    if (result.data.devCode && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(getEndpoint())) {
      setResetCode(result.data.devCode);
      setNotice({ type: "ok", text: `本地开发模式：验证码 ${result.data.devCode}（10 分钟内有效）` });
    } else {
      setNotice({ type: "ok", text: "验证码已发送，请检查邮箱" });
    }
  }

  async function submitPasswordReset(event: React.FormEvent) {
    event.preventDefault();
    const emailError = checkEmail(resetEmail);
    const codeError = checkCode(resetCode);
    const passwordError = checkPassword(resetPassword);
    if (emailError || codeError || passwordError) {
      setNotice({ type: "err", text: emailError || codeError || passwordError });
      return;
    }
    setBusy(true); setNotice(null);
    const result = await authApi.resetPassword(resetEmail, resetCode, resetPassword);
    setBusy(false);
    if (!result.ok) { setNotice({ type: "err", text: result.message }); return; }
    setEmail(resetEmail);
    setPassword("");
    setResetOpen(false);
    setEmailMode("login");
    setNotice({ type: "ok", text: "密码已重置，请使用新密码登录" });
  }

  const isRegister = emailMode === "register";

  if (resetOpen) {
    return (
      <div className="auth-panel">
        <header className="auth-panel__head">
          <div className="auth-panel__badge"><ShieldCheck size={16} />账号安全</div>
          <h2>重置登录密码</h2>
          <p>通过邮箱验证码验证身份后设置新密码</p>
        </header>
        <form className="auth-form" onSubmit={submitPasswordReset} noValidate>
          <Field label="QQ 邮箱" error={undefined}>
            <div className="auth-input"><Mail size={16} /><input value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} type="email" inputMode="email" autoComplete="username" placeholder="123456789@qq.com" maxLength={64} /></div>
          </Field>
          <Field label="邮箱验证码" hint="6 位数字" error={undefined}>
            <div className="auth-input"><Mail size={16} /><input value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, "").slice(0, 6))} type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" maxLength={6} /><button type="button" className="auth-input__send" disabled={busy || resetCountdown > 0} onClick={sendPasswordResetCode}>{resetCountdown > 0 ? `${resetCountdown}s` : "获取验证码"}</button></div>
          </Field>
          <Field label="新密码" hint="8~32 位，需含字母和数字" error={undefined}>
            <div className="auth-input"><Lock size={16} /><input value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} type={showResetPassword ? "text" : "password"} autoComplete="new-password" placeholder="请输入新密码" maxLength={32} /><button type="button" className="auth-input__action" aria-label={showResetPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowResetPassword((value) => !value)}>{showResetPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
          </Field>
          {notice && <div className={`auth-notice is-${notice.type}`} role="status">{notice.text}</div>}
          <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? "处理中…" : "确认重置"}{!busy && <ArrowRight size={16} />}</button>
          <p className="auth-switch"><button type="button" onClick={() => { setResetOpen(false); setNotice(null); }}>返回登录</button></p>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <header className="auth-panel__head">
        <div className="auth-panel__badge">
          <ShieldCheck size={16} />
          账号中心
        </div>
        <h2>{isRegister && channel === "email" ? "创建途迹账号" : "登录途迹"}</h2>
        <p>
          {channel === "email"
            ? "用 QQ 邮箱登录，保护账号与 AI 服务访问"
            : "用手机号 + 短信验证码登录，未注册将自动创建账号"}
        </p>
      </header>

      <div className="auth-tabs" role="tablist" aria-label="登录方式">
        <button
          type="button"
          role="tab"
          aria-selected={channel === "email"}
          className={channel === "email" ? "active" : ""}
          onClick={() => {
            setChannel("email");
            setNotice(null);
          }}
        >
          <Mail size={16} />
          QQ 邮箱
        </button>
        {SMS_LOGIN_ENABLED ? (
          <button
            type="button"
            role="tab"
            aria-selected={channel === "sms"}
            className={channel === "sms" ? "active" : ""}
            onClick={() => {
              setChannel("sms");
              setNotice(null);
            }}
          >
            <Smartphone size={16} />
            手机号
          </button>
        ) : null}
      </div>

      {channel === "email" ? (
        <form className="auth-form" onSubmit={submitEmail} noValidate>
          <Field label="QQ 邮箱" hint="数字 QQ 号@qq.com 或 别名@foxmail.com" error={errors.email}>
            <div className="auth-input">
              <Mail size={16} />
              <input
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("email", "");
                  setNotice(null);
                }}
                onBlur={() => setEmail(normalizeEmail(email))}
                type="text"
                inputMode="email"
                autoComplete="username"
                placeholder="123456789@qq.com"
                maxLength={64}
              />
            </div>
          </Field>

          <Field label="密码" hint={isRegister ? "8~32 位，需含字母和数字" : undefined} error={errors.password}>
            <div className="auth-input">
              <Lock size={16} />
              <input
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError("password", "");
                  setNotice(null);
                }}
                type={showPassword ? "text" : "password"}
                autoComplete={isRegister ? "new-password" : "current-password"}
                placeholder="请输入密码"
                maxLength={32}
              />
              <button
                type="button"
                className="auth-input__action"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {isRegister && password ? (
              <span className={`auth-strength s${strength}`}>
                <i />
                <i />
                <i />
                <em>{strength === 0 ? "强度偏弱" : strength === 1 ? "强度中等" : "强度良好"}</em>
              </span>
            ) : null}
          </Field>

          {isRegister ? (
            <label className="auth-check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>
                我已阅读并同意 <button type="button" className="auth-inline-link" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDoc("terms"); }}>《用户协议》</button> 与 <button type="button" className="auth-inline-link" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDoc("privacy"); }}>《隐私政策》</button>
              </span>
            </label>
          ) : null}

          <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "处理中…" : isRegister ? "注 册" : "登 录"}
            {!busy && <ArrowRight size={16} />}
          </button>

          {!isRegister ? <button type="button" className="auth-forgot" onClick={() => { setResetEmail(email); setResetOpen(true); setNotice(null); }}>忘记密码？</button> : null}

          <p className="auth-switch">
            {isRegister ? "已有账号？" : "还没有账号？"}
            <button
              type="button"
              onClick={() => {
                setEmailMode(isRegister ? "login" : "register");
                setNotice(null);
                setErrors({});
              }}
            >
              {isRegister ? "返回登录" : "立即注册"}
            </button>
          </p>
        </form>
      ) : (
        <form className="auth-form" onSubmit={submitPhone} noValidate>
          <Field label="手机号" hint="中国大陆 11 位" error={errors.phone}>
            <div className="auth-input">
              <span className="auth-input__prefix">+86</span>
              <input
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, "").slice(0, 11));
                  setError("phone", "");
                  setNotice(null);
                }}
                onBlur={() => setPhone(normalizePhone(phone))}
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="请输入手机号"
                maxLength={11}
              />
            </div>
          </Field>

          <Field label="短信验证码" hint="6 位数字，5 分钟内有效" error={errors.code}>
            <div className="auth-input">
              <Smartphone size={16} />
              <input
                ref={codeInput}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  setError("code", "");
                  setNotice(null);
                }}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 位数字"
                maxLength={6}
              />
              <button
                type="button"
                className="auth-input__send"
                disabled={busy || countdown > 0}
                onClick={sendCode}
              >
                {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
              </button>
            </div>
          </Field>

          <label className="auth-check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
                我已阅读并同意 <button type="button" className="auth-inline-link" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDoc("terms"); }}>《用户协议》</button> 与 <button type="button" className="auth-inline-link" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLegalDoc("privacy"); }}>《隐私政策》</button>
            </span>
          </label>

          <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "处理中…" : "登 录 / 注 册"}
            {!busy && <ArrowRight size={16} />}
          </button>
        </form>
      )}

      {notice ? (
        <p className={`auth-notice ${notice.type === "err" ? "is-err" : "is-ok"}`} role="status">
          {notice.text}
        </p>
      ) : null}

      <div className="auth-endpoint">
        {import.meta.env.PROD && import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS !== "true" ? (
          <p className="auth-endpoint__fixed">
            <Server size={14} />
            账号服务地址：{getEndpoint() || "未配置"}
          </p>
        ) : (
          <>
            <button type="button" className="auth-endpoint__toggle" onClick={() => setShowEndpoint((v) => !v)}>
              <Server size={14} />
              账号服务地址：{getEndpoint() || "未配置"}
            </button>
            {showEndpoint ? (
          <div className="auth-endpoint__body">
            <input value={endpointDraft} onChange={(e) => setEndpointDraft(e.target.value)} placeholder={DEFAULT_ENDPOINT || "https://账号服务域名"} />
            <button
              type="button"
              onClick={() => {
                try {
                  setEndpoint(endpointDraft);
                  setNotice({ type: "ok", text: `已切换为 ${getEndpoint()}` });
                } catch (error) {
                  setNotice({ type: "err", text: error instanceof Error ? error.message : "账号服务地址无效" });
                }
              }}
            >
              保存
            </button>
            <p>Android 模拟器使用 10.0.2.2，真机 Debug 可填写电脑局域网 IP；Release 包必须使用 HTTPS 域名。本地网页和桌面开发默认使用 127.0.0.1。</p>
          </div>
            ) : null}
          </>
        )}
        <ServiceStatus />
      </div>
      {legalDoc ? (
        <div className="auth-legal-backdrop" role="presentation" onClick={() => setLegalDoc(null)}>
          <section className="auth-legal-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-legal-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="auth-legal-title">{legalDoc === "terms" ? "用户协议" : "隐私政策"}</h3>
            <p>{legalDoc === "terms"
              ? "你可以使用途迹创建和管理个人旅行计划。请确保填写的信息合法、真实，并自行核对景区、交通、天气与费用信息。"
              : "账号信息仅用于登录身份和账号服务。行程、记账、打卡与 API Key 默认保存在本机；网络请求会发送到你配置的账号服务和 AI 服务。我们不会在本应用内出售你的个人信息。"}</p>
            <button type="button" className="auth-submit auth-submit--ghost" onClick={() => setLegalDoc(null)}>知道了</button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 已登录 */

function ProfilePanel({ user, onLogout, onCheckUpdate }: { user: AuthUser; onLogout: () => Promise<void>; onCheckUpdate: () => Promise<void> }) {
  const [logoutBusy, setLogoutBusy] = useState(false);

  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await onLogout();
    } finally {
      setLogoutBusy(false);
    }
  }
  const rows: [string, string][] = [
    ["用户 ID", String(user.id)],
    ["QQ 邮箱", user.email ?? "未绑定"],
    ["手机号", user.phone ?? "未绑定"],
    ["昵称", user.nickname ?? "—"],
    ["邮箱验证", user.emailVerified ? "已验证" : "未验证"],
    ["手机号验证", user.phoneVerified ? "已验证" : "未验证"],
  ];
  return (
    <div className="auth-panel">
      <header className="auth-panel__head">
        <div className="auth-panel__badge">
          <CheckCircle2 size={16} />
          已登录
        </div>
        <h2>
          <UserRound size={18} /> {user.nickname ?? "途迹用户"}
        </h2>
        <p>退出登录后需要重新登录才能进入行程工作区；本机行程、清单、记账、打卡和提醒数据会保留，重新登录后可继续使用。</p>
      </header>

      <dl className="auth-profile">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="auth-profile__service" aria-label="服务状态">
        <strong>服务状态</strong>
        <ServiceStatus />
      </div>

      <div className="auth-actions">
        <button className="auth-submit auth-submit--ghost" type="button" onClick={() => void onCheckUpdate()}>
          <RefreshCw size={16} />
          检查更新
        </button>
        <button className="auth-submit auth-submit--ghost" type="button" onClick={() => void logout()} disabled={logoutBusy}>
          <LogOut size={16} />
          {logoutBusy ? "正在退出…" : "退出登录"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 导出 */

export function AccountView({ user, ready, onLoggedIn, onLogout, onCheckUpdate, storageError }: Props) {
  if (!ready) {
    return <div className="auth-wrap auth-loading" role="status" aria-live="polite"><RefreshCw className="spin" size={20} /> 正在恢复安全会话…</div>;
  }
  return (
    <div className="auth-wrap">
      {user ? (
        <ProfilePanel user={user} onLogout={onLogout} onCheckUpdate={onCheckUpdate} />
      ) : (
        <LoginPanel onLoggedIn={onLoggedIn} />
      )}
      {storageError ? <p className="auth-notice is-err" role="alert">{storageError}</p> : null}
      <aside className="auth-aside">
        <h3>为什么需要登录</h3>
        <ul>
          <li>账号用于登录身份和 AI 服务鉴权；当前版本的行程数据仍保存在本机，尚未接入云同步。</li>
          <li>登录后可使用行程规划、打包清单、记账、打卡和出行提醒；退出登录不会删除本机数据。</li>
          <li>当前支持 QQ 邮箱密码登录；手机号验证码登录暂未开放。</li>
        </ul>
        <h3>安全约定</h3>
        <ul>
          <li>密码用 scrypt + 随机盐存储，数据库里看不到明文。</li>
          <li>会话只保存令牌哈希；登出即刻失效。</li>
          <li>连续输错 5 次锁定 15 分钟；短信登录暂未开放。</li>
        </ul>
      </aside>
    </div>
  );
}
