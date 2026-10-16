import { Building2, CalendarClock, CheckCircle2, ListPlus, RefreshCw, Sparkles, Ticket } from "lucide-react";
import type { AgentProposal, TravelAgentAction, TravelAgentSuggestion } from "./travel-agent";

function actionLabel(action: TravelAgentAction) {
  if (action === "focus-day") return "查看这一天";
  if (action === "add-reminder") return "加入行前待办";
  if (action === "hotel-search") return "查找住宿";
  if (action === "ticket-search") return "打开购票入口";
  return "刷新天气";
}

export function TravelAgentPanel({
  suggestions,
  notice,
  onAction,
  onAskAi,
  onApplyAction,
  onDismiss,
  proposal,
  busy = false,
  error = "",
}: {
  suggestions: TravelAgentSuggestion[];
  notice: string;
  onAction: (suggestion: TravelAgentSuggestion) => void;
  onAskAi?: () => void;
  onApplyAction?: (index: number) => void;
  onDismiss?: () => void;
  proposal?: AgentProposal | null;
  busy?: boolean;
  error?: string;
}) {
  return (
    <section className="travel-agent-card" aria-label="我的行程管家">
      <div className="travel-agent-head">
        <div className="travel-agent-title">
          <span className="travel-agent-icon"><Sparkles size={16} /></span>
          <div>
            <strong>我的行程管家</strong>
            <small>读取本地行程、天气和预算，先建议再执行</small>
          </div>
        </div>
        <span className="travel-agent-badge">本地 Agent</span>
      </div>
      {onAskAi && <button type="button" className="travel-agent-ai-button" onClick={onAskAi} disabled={busy}>
        <Sparkles size={14} />{busy ? "AI 正在分析…" : "让 AI 深度分析"}
      </button>}
      {error && <p className="travel-agent-error" role="alert">{error}</p>}
      {proposal && <div className="travel-agent-proposal">
        <strong>AI 提案</strong><p>{proposal.summary}</p>
        {proposal.warnings.map((warning) => <p className="travel-agent-warning" key={warning}>⚠ {warning}</p>)}
        {proposal.actions.length === 0 && <p>没有需要确认执行的调整。</p>}
        {proposal.actions.map((action, index) => <div className="travel-agent-proposal-item" key={`${action.type}-${index}`}>
          <div><b>{action.type === "add_todo" ? `新增待办：${action.text}` : action.type === "reschedule_activity" ? `调整第 ${action.day + 1} 天第 ${action.index + 1} 项至 ${action.time}` : `替换第 ${action.day + 1} 天第 ${action.index + 1} 项为「${action.activity.title}」`}</b><small>{action.reason}</small></div>
          {onApplyAction && <button type="button" onClick={() => onApplyAction(index)}>确认执行</button>}
        </div>)}
        {onDismiss && <button type="button" className="travel-agent-dismiss" onClick={onDismiss}>全部忽略</button>}
      </div>}
      {notice && <p className="travel-agent-notice" role="status"><CheckCircle2 size={14} />{notice}</p>}
      <div className="travel-agent-list">
        {suggestions.map((item) => (
          <article className={`travel-agent-item ${item.level}`} key={item.id}>
            <div className="travel-agent-item-copy">
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
            <button type="button" onClick={() => onAction(item)}>
              {item.action === "focus-day" ? <CalendarClock size={14} /> : item.action === "add-reminder" ? <ListPlus size={14} /> : item.action === "hotel-search" ? <Building2 size={14} /> : item.action === "ticket-search" ? <Ticket size={14} /> : <RefreshCw size={14} />}
              {actionLabel(item.action)}
            </button>
          </article>
        ))}
      </div>
      <p className="travel-agent-footnote">涉及修改行程或新增待办时，需要你点击确认；不会自动删除安排或执行付款。</p>
    </section>
  );
}
