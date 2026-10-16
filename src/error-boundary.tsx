import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean; errorId: string };

function createErrorId() {
  try { return crypto.randomUUID(); } catch { return `ERR-${Date.now().toString(36).toUpperCase()}`; }
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, errorId: "" };

  static getDerivedStateFromError(): State {
    return { failed: true, errorId: createErrorId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Route app render error", { errorId: this.state.errorId, error, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-error" role="alert">
        <div className="app-error__card">
          <div className="app-error__mark">!</div>
          <h1>页面暂时出了点问题</h1>
          <p>你的本机行程数据仍保存在设备上。刷新页面后可以继续使用。</p>
          <button type="button" onClick={() => window.location.reload()}>刷新并恢复</button>
          <small>错误编号：{this.state.errorId}</small>
        </div>
      </main>
    );
  }
}
