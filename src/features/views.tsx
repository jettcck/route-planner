import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  Check,
  ClipboardList,
  Coins,
  Copy,
  Info,
  ListChecks,
  Plus,
  Receipt,
  RefreshCw,
  Thermometer,
  Trash2,
  TrendingUp,
  Users,
} from "lucide-react";
import type { PlannerInput, Trip } from "../types";
import type { Weather } from "../weather";
import {
  generatePackingList,
  MAX_PACKING_ITEMS,
  mergePackingList,
  packingCategories,
  packingProgress,
  sanitizePackingItems,
  type PackingItem,
} from "./packing";
import {
  currencies,
  defaultMembers,
  defaultPayer,
  defaultRate,
  estimatedTotal,
  expenseCategories,
  MAX_EXPENSES,
  sanitizeExpenses,
  summarize,
  toCny,
  type CurrencyCode,
  type Expense,
  type ExpenseCategory,
} from "./ledger";
import {
  activityStableKey,
  checkInStats,
  readCheckIn,
  formatCheckInTime,
  type CheckInMap,
} from "./checkin";
import type { Advisory, Countdown } from "./reminders";
import { prepTodos } from "./reminders";
import { downloadText, tripToMarkdown, copyText } from "./share";
import { loadJson, tripNamespace, uid, useStoredState } from "./store";

export type TripProps = {
  trip: Trip;
  input: PlannerInput;
  weather: Weather[];
};

function money(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}

function ViewHeader({
  kicker,
  title,
  description,
}: {
  kicker: string;
  title: string;
  description: string;
}) {
  return (
    <div className="view-header">
      <div className="eyebrow">{kicker}</div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function Progress({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="progress-block">
      <div className="progress-meta">
        <span>{label}</span>
        <b>{percent}%</b>
      </div>
      <div className="progress-track">
        <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------- 打包清单 --------------------------------- */

export function PackingView({ trip, input, weather, refreshToken = 0 }: TripProps & { refreshToken?: number }) {
  const key = `route-packing:${tripNamespace(trip)}`;
  const [items, setItems] = useStoredState<PackingItem[]>(key, [], sanitizePackingItems);
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<(typeof packingCategories)[number]>("其他");
  const progress = packingProgress(items);

  useEffect(() => {
    if (refreshToken === 0) return;
    const restored = sanitizePackingItems(loadJson<unknown>(key, [])) ?? [];
    setItems(restored);
  }, [key, refreshToken]);

  const regenerate = () => {
    setItems((previous) =>
      mergePackingList(previous, generatePackingList(trip, input, weather)),
    );
  };

  return (
    <section className="feature-view" aria-label="打包清单">
      <ViewHeader
        kicker="PACKING LIST"
        title="打包清单"
        description="按目的地、天数、天气与活动类型自动生成，勾选状态会保存在本机。"
      />
      <div className="stat-row">
        <div className="stat-card">
          <ClipboardList size={18} />
          <span>
            <b>
              {progress.done} / {progress.total}
            </b>
            <small>已备齐</small>
          </span>
        </div>
        <div className="stat-card">
          <Check size={18} />
          <span>
            <b>{progress.percent}%</b>
            <small>完成度</small>
          </span>
        </div>
        <div className="stat-card">
          <CalendarDays size={18} />
          <span>
            <b>{trip.days.length} 天</b>
            <small>{trip.destination}</small>
          </span>
        </div>
      </div>
      <Progress percent={progress.percent} label="打包进度" />
      <div className="action-row">
        <button className="primary-action" onClick={regenerate}>
          <RefreshCw size={16} />
          按当前行程重新生成
        </button>
        {progress.total > 0 && (
          <button
            className="ghost-action"
            onClick={() =>
              setItems((previous) =>
                previous.map((item) => ({ ...item, checked: false })),
              )
            }
          >
            全部取消勾选
          </button>
        )}
      </div>

      {!items.length && (
        <p className="empty-hint">
          还没有清单，点「按当前行程重新生成」即可按天气与活动类型推导要带的东西。
        </p>
      )}

      {packingCategories.map((category) => {
        const group = items.filter((item) => item.category === category);
        if (!group.length) return null;
        const done = group.filter((item) => item.checked).length;
        return (
          <div className="pack-group" key={category}>
            <div className="pack-group-head">
              <h3>{category}</h3>
              <span>
                {done}/{group.length}
              </span>
            </div>
            <ul className="check-list">
              {group.map((item) => (
                <li key={item.id} className={item.checked ? "done" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() =>
                        setItems((previous) =>
                          previous.map((entry) =>
                            entry.id === item.id
                              ? { ...entry, checked: !entry.checked }
                              : entry,
                          ),
                        )
                      }
                    />
                    <span className="check-label">{item.label}</span>
                  </label>
                  {item.reason ? <em>{item.reason}</em> : null}
                  {item.custom && (
                    <button
                      title="删除"
                      aria-label={`删除 ${item.label}`}
                      className="row-delete"
                      onClick={() =>
                        setItems((previous) =>
                          previous.filter((entry) => entry.id !== item.id),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="inline-form">
        <input
          value={draft}
          placeholder="补充要带的东西，例如：折叠伞"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !draft.trim()) return;
            setItems((previous) => previous.length >= MAX_PACKING_ITEMS ? previous : [
              ...previous,
              { id: uid("pack"), label: draft.trim(), category: draftCategory, checked: false, custom: true },
            ]);
            setDraft("");
          }}
        />
        <select
          value={draftCategory}
          onChange={(event) =>
            setDraftCategory(event.target.value as (typeof packingCategories)[number])
          }
        >
          {packingCategories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <button
          className="primary-action"
          disabled={!draft.trim() || items.length >= MAX_PACKING_ITEMS}
          onClick={() => {
            setItems((previous) => previous.length >= MAX_PACKING_ITEMS ? previous : [
              ...previous,
              { id: uid("pack"), label: draft.trim(), category: draftCategory, checked: false, custom: true },
            ]);
            setDraft("");
          }}
        >
          <Plus size={16} />
          {items.length >= MAX_PACKING_ITEMS ? "已达上限" : "添加"}
        </button>
      </div>
      {items.length >= MAX_PACKING_ITEMS && (
        <p className="empty-hint">已达到 {MAX_PACKING_ITEMS} 项清单上限，请先删除不需要的条目。</p>
      )}
    </section>
  );
}

/* ---------------------------------- 记账结算 --------------------------------- */

export function LedgerView({
  trip,
  input,
  expenses,
  setExpenses,
}: TripProps & {
  expenses: Expense[];
  setExpenses: (next: Expense[] | ((previous: Expense[]) => Expense[])) => void;
}) {
  const members = defaultMembers(input.travelers);
  const [draft, setDraft] = useState<Omit<Expense, "id">>({
    date: trip.days[0]?.date ?? "",
    category: "餐饮",
    title: "",
    amount: 0,
    currency: "CNY",
    rate: 1,
    paidBy: defaultPayer,
    shares: Math.max(1, input.travelers),
  });
  const summary = summarize(expenses, input.budget, members);
  const [draftError, setDraftError] = useState("");
  const estimated = estimatedTotal(trip);
  const maxCategory = summary.byCategory[0]?.amount ?? 0;

  const add = () => {
    if (!draft.title.trim() || draft.amount <= 0) return;
    // Snapshot the participants when this expense is created. Future edits to
    // the trip's traveler count must not alter already recorded expenses.
    const shares = Math.min(members.length, Math.max(1, Math.trunc(draft.shares)));
    const candidate = { ...draft, id: uid("exp"), shares, participants: members.slice(0, shares) };
    const cleaned = sanitizeExpenses([candidate]);
    if (!cleaned?.length || draft.rate <= 0) {
      setDraftError("请填写有效的日期、金额和大于 0 的汇率");
      return;
    }
    setDraftError("");
    setExpenses((previous) =>
      previous.length >= MAX_EXPENSES
        ? previous
        : [cleaned[0], ...previous],
    );
    setDraft((previous) => ({ ...previous, title: "", amount: 0 }));
  };

  return (
    <section className="feature-view" aria-label="记账结算">
      <ViewHeader
        kicker="BUDGET & EXPENSES"
        title="记账与结算"
        description="记录实付金额与付款人，自动折算人民币、对比预算，并给出 AA 结算方案。"
      />
      <div className="stat-row">
        <div className="stat-card">
          <Coins size={18} />
          <span>
            <b>{money(summary.total)}</b>
            <small>已花 {summary.count} 笔</small>
          </span>
        </div>
        <div className="stat-card">
          <Users size={18} />
          <span>
            <b>{money(summary.perPerson)}</b>
            <small>人均（{summary.balances.length} 人）</small>
          </span>
        </div>
        <div className={`stat-card ${summary.remaining < 0 ? "danger" : ""}`}>
          <Banknote size={18} />
          <span>
            <b>{money(summary.remaining)}</b>
            <small>预算剩余 {money(input.budget)}</small>
          </span>
        </div>
      </div>
      <Progress percent={summary.usedPercent} label="预算使用进度" />
      <p className="estimate-line">
        行程估算 {money(estimated)}
        {summary.total > 0 && (
          <>
            {" · "}
            {summary.total > estimated ? "实付已超估算 " : "实付低于估算 "}
            {money(Math.abs(summary.total - estimated))}
          </>
        )}
      </p>

      <div className="ledger-form">
        <div className="field-row">
          <label className="field">
            <span>日期</span>
            <input
              type="date"
              value={draft.date}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, date: event.target.value }))
              }
            />
          </label>
          <label className="field">
            <span>类别</span>
            <select
              value={draft.category}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  category: event.target.value as ExpenseCategory,
                }))
              }
            >
              {expenseCategories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>项目</span>
          <input
            value={draft.title}
            maxLength={160}
            placeholder="例如：机场大巴 4 人"
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, title: event.target.value }))
            }
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>金额</span>
            <input
              type="number"
              min="0"
              max="10000000"
              step="0.01"
              value={draft.amount}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  amount: Number.isFinite(Number(event.target.value))
                    ? Math.min(10_000_000, Math.max(0, Number(event.target.value)))
                    : 0,
                }))
              }
            />
          </label>
          <label className="field">
            <span>币种</span>
            <select
              value={draft.currency}
              onChange={(event) => {
                const code = event.target.value as CurrencyCode;
                setDraft((previous) => ({
                  ...previous,
                  currency: code,
                  rate: defaultRate(code),
                }));
              }}
            >
              {currencies.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>汇率（1 外币 = ¥）</span>
            <input
              type="number"
              min="0"
              max="1000000"
              step="0.0001"
              value={draft.rate}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  rate: Number.isFinite(Number(event.target.value))
                    ? Math.min(1_000_000, Math.max(0, Number(event.target.value)))
                    : 0,
                }))
              }
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>付款人</span>
            <select
              value={draft.paidBy}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, paidBy: event.target.value }))
              }
            >
              {members.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>分摊人数</span>
            <input
              type="number"
              min="1"
              max={Math.max(1, members.length)}
              value={draft.shares}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  shares: Math.min(
                    members.length,
                    Math.max(1, Math.trunc(Number(event.target.value)) || 1),
                  ),
                  participants: undefined,
                }))
              }
            />
          </label>
        </div>
        <button className="primary-action" onClick={add} disabled={!draft.title.trim() || draft.amount <= 0 || expenses.length >= MAX_EXPENSES}>
          <Plus size={16} />
          {expenses.length >= MAX_EXPENSES ? "已达记录上限" : "记一笔"}
        </button>
        {draftError && <p className="empty-hint" role="alert">{draftError}</p>}
        {expenses.length >= MAX_EXPENSES && (
          <p className="empty-hint">已达到 {MAX_EXPENSES} 笔记账上限，请先导出备份后清理旧记录。</p>
        )}
      </div>

      {summary.byCategory.length > 0 && (
        <div className="category-bars">
          {summary.byCategory.map((item) => (
            <div className="category-bar" key={item.category}>
              <span className="category-name">{item.category}</span>
              <div className="category-track">
                <span
                  style={{
                    width: `${maxCategory ? Math.max(6, Math.round((item.amount / maxCategory) * 100)) : 0}%`,
                  }}
                />
              </div>
              <span className="category-amount">
                {money(item.amount)} · {item.percent}%
              </span>
            </div>
          ))}
        </div>
      )}

      {summary.settlements.length > 0 && (
        <div className="settle-block">
          <h3>
            <TrendingUp size={16} /> AA 结算建议
          </h3>
          <ul>
            {summary.settlements.map((item, index) => (
              <li key={index}>
                <b>{item.from}</b> 转给 <b>{item.to}</b>
                <span>{money(item.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="estimate-line">
            垫付最多：{summary.balances[0]?.name} {money(summary.balances[0]?.paid ?? 0)}
          </p>
        </div>
      )}

      <div className="expense-list">
        <div className="pack-group-head">
          <h3>明细</h3>
          <span>{expenses.length} 笔</span>
        </div>
        {!expenses.length && <p className="empty-hint">还没有记账。旅途中随手记一笔，回程可直接结算。</p>}
        {expenses.map((item) => (
          <div className="expense-row" key={item.id}>
            <span className="expense-cat">{item.category}</span>
            <div className="expense-main">
              <b>{item.title}</b>
              <small>
                {shortDate(item.date)} · {item.paidBy} 付 · {item.shares} 人分摊
                {item.currency !== "CNY" ? ` · ${item.amount} ${item.currency} @${item.rate}` : ""}
              </small>
            </div>
            <span className="expense-amount">{money(toCny(item))}</span>
            <button
              className="row-delete"
              title="删除"
              aria-label={`删除 ${item.title}`}
              onClick={() =>
                setExpenses((previous) =>
                  previous.filter((entry) => entry.id !== item.id),
                )
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------- 打卡足迹 --------------------------------- */

export function CheckInView({
  trip,
  checkIns,
  onToggle,
  onNote,
}: {
  trip: Trip;
  checkIns: CheckInMap;
  onToggle: (key: string) => void;
  onNote: (key: string, note: string) => void;
}) {
  const stats = checkInStats(trip, checkIns);
  return (
    <section className="feature-view" aria-label="打卡足迹">
      <ViewHeader
        kicker="CHECK-IN & FOOTPRINT"
        title="打卡与足迹"
        description="走到哪记到哪，自动统计完成率与首末打卡时间，方便回看这趟行程走了多少。"
      />
      <div className="stat-row">
        <div className="stat-card">
          <Check size={18} />
          <span>
            <b>
              {stats.done} / {stats.total}
            </b>
            <small>已打卡</small>
          </span>
        </div>
        <div className="stat-card">
          <TrendingUp size={18} />
          <span>
            <b>{stats.percent}%</b>
            <small>完成率</small>
          </span>
        </div>
        <div className="stat-card">
          <CalendarDays size={18} />
          <span>
            <b>{trip.destination}</b>
            <small>
              {stats.firstAt ? `${shortDate(stats.firstAt.slice(0, 10))} 起` : "尚未开始"}
            </small>
          </span>
        </div>
      </div>
      <Progress percent={stats.percent} label="打卡进度" />

      {trip.days.map((day, dayIndex) => (
        <div className="pack-group" key={`${day.date}-${dayIndex}`}>
          <div className="pack-group-head">
            <h3>
              DAY {String(dayIndex + 1).padStart(2, "0")} · {shortDate(day.date)}
            </h3>
            <span>
              {stats.perDay[dayIndex]?.done ?? 0}/{day.activities.length}
            </span>
          </div>
          <ul className="check-list">
            {day.activities.map((item, index) => {
              const key = activityStableKey(trip, dayIndex, index);
              const record = readCheckIn(checkIns, trip, dayIndex, index);
              return (
                <li key={key} className={record ? "done" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(record)}
                      onChange={() => onToggle(key)}
                    />
                    <span className="check-label">
                      {item.time} {item.title}
                    </span>
                  </label>
                  {record ? (
                    <input
                      className="note-input"
                      value={record.note}
                      maxLength={2_000}
                      placeholder="记一句旅途感受（可选）"
                      onChange={(event) => onNote(key, event.target.value)}
                    />
                  ) : (
                    <em>{item.location || "地点待定"}</em>
                  )}
                  {record && <em>{formatCheckInTime(record.at)}</em>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* ---------------------------------- 出行提醒 --------------------------------- */

export function PrepView({
  countdown,
  advisories,
  weatherStatus,
  weatherUpdatedAt,
  weatherStale,
  weatherLoading,
  onRefreshWeather,
  todos,
  onToggleTodo,
  agentReminders,
  onToggleAgentReminder,
}: {
  countdown: Countdown;
  advisories: Advisory[];
  weatherStatus: string;
  weatherUpdatedAt: string;
  weatherStale: boolean;
  weatherLoading: boolean;
  onRefreshWeather: () => void;
  todos: Record<string, boolean>;
  onToggleTodo: (id: string) => void;
  agentReminders: string[];
  onToggleAgentReminder: (text: string) => void;
}) {
  const done = prepTodos.filter((item) => todos[item.id]).length;
  const updatedLabel = weatherUpdatedAt
    ? new Date(weatherUpdatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "尚未更新";
  return (
    <section className="feature-view" aria-label="出行提醒">
      <ViewHeader
        kicker="TRIP REMINDERS"
        title="出行提醒"
        description="出发倒计时、天气风险提示与行前待办清单，把「出发前要确认的事」集中在一处。"
      />
      <div className={`countdown-card ${countdown.status === "进行中" ? "active" : ""}`}>
        <CalendarDays size={20} />
        <div>
          <b>{countdown.label}</b>
          <small>{countdown.detail}</small>
        </div>
      </div>

      <div className="pack-group">
        <div className="pack-group-head">
          <h3>
            <Thermometer size={15} /> 实时天气与出行建议
          </h3>
          <div className="weather-actions">
            <span title={weatherStatus}>{weatherStale ? "缓存数据" : `更新于 ${updatedLabel}`}</span>
            <button type="button" onClick={onRefreshWeather} disabled={weatherLoading} title="立即刷新天气">
              <RefreshCw size={14} className={weatherLoading ? "spin" : ""} />
              {weatherLoading ? "更新中" : "刷新"}
            </button>
          </div>
        </div>
        <ul className="advisory-list">
          {advisories.map((item, index) => (
            <li key={index} className={`advisory ${item.level}`}>
              {item.level === "info" ? <Info size={15} /> : <AlertTriangle size={15} />}
              <div>
                <b>{item.title}</b>
                <span>{item.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="pack-group">
        <div className="pack-group-head">
          <h3>
            <ListChecks size={15} /> 行前待办
          </h3>
          <span>
            {done}/{prepTodos.length}
          </span>
        </div>
        <ul className="check-list">
          {prepTodos.map((item) => (
            <li key={item.id} className={todos[item.id] ? "done" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(todos[item.id])}
                  onChange={() => onToggleTodo(item.id)}
                />
                <span className="check-label">{item.label}</span>
              </label>
              <em>{item.hint}</em>
            </li>
          ))}
        </ul>
      </div>
      {agentReminders.length > 0 && (
        <div className="pack-group agent-reminder-group">
          <div className="pack-group-head">
            <h3><ListChecks size={15} /> 行程管家建议</h3>
            <span>{agentReminders.filter((item) => todos[`agent:${item}`]).length}/{agentReminders.length}</span>
          </div>
          <ul className="check-list">
            {agentReminders.map((item) => {
              const key = `agent:${item}`;
              return (
                <li key={item} className={todos[key] ? "done" : ""}>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(todos[key])}
                      onChange={() => onToggleAgentReminder(item)}
                    />
                    <span className="check-label">{item}</span>
                  </label>
                  <em>由行程管家建议</em>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------- 行程体检卡片 --------------------------------- */

export function HealthCard({
  issues,
  tone = "normal",
}: {
  issues: { level: "risk" | "warn" | "info"; title: string; detail: string }[];
  /** alert：超预算时置顶强调。 */
  tone?: "normal" | "alert";
}) {
  const [expanded, setExpanded] = useState(false);
  const risks = issues.filter((item) => item.level === "risk").length;
  const warns = issues.filter((item) => item.level === "warn").length;
  const shown = expanded ? issues : issues.slice(0, 3);
  return (
    <section className={`health-card ${tone}`} aria-label="行程体检">
      <div className="health-head">
        <div className="health-icon">
          <ClipboardList size={17} />
        </div>
        <div>
          <strong>行程体检</strong>
          <p>
            {risks > 0
              ? `发现 ${risks} 处高风险、${warns} 处需注意`
              : warns > 0
                ? `有 ${warns} 处需要留意`
                : "时间顺序、单日强度与预算都在常规范围内"}
          </p>
        </div>
        {issues.length > 3 && (
          <button className="map-app-refresh" onClick={() => setExpanded(!expanded)}>
            {expanded ? "收起" : `查看全部 ${issues.length} 条`}
          </button>
        )}
      </div>
      <ul className="advisory-list">
        {shown.map((item, index) => (
          <li key={index} className={`advisory ${item.level}`}>
            {item.level === "info" ? <Info size={15} /> : <AlertTriangle size={15} />}
            <div>
              <b>{item.title}</b>
              <span>{item.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------- 分享导出 --------------------------------- */

export function ShareCard({
  trip,
  input,
  weather,
  expenses,
  checkIns,
}: TripProps & { expenses: Expense[]; checkIns: CheckInMap }) {
  const [state, setState] = useState("");
  const markdown = () =>
    tripToMarkdown(trip, input, weather, expenses, checkIns);
  return (
    <section className="health-card" aria-label="分享行程">
      <div className="health-head">
        <div className="health-icon">
          <Receipt size={17} />
        </div>
        <div>
          <strong>分享行程</strong>
          <p>生成带天气、花费与打卡进度的文本，可直接粘贴到聊天群。</p>
        </div>
      </div>
      <div className="action-row">
        <button
          className="ghost-action"
          onClick={async () => {
            const ok = await copyText(markdown());
            setState(ok ? "已复制到剪贴板" : "复制失败，请改用下载");
          }}
        >
          <Copy size={15} />
          复制行程文本
        </button>
        <button
          className="ghost-action"
          onClick={async () => {
            // downloadText 是异步的（安卓优先走原生分享）；不 await 会在真正
            // 落盘前就显示"已下载"，失败时用户也看不到原因。
            try {
              await downloadText(
                `${trip.destination || "旅行"}-行程.md`,
                markdown(),
                "text/markdown;charset=utf-8",
              );
              setState("已下载 Markdown");
            } catch (reason) {
              setState(`下载失败：${reason instanceof Error ? reason.message : String(reason)}`);
            }
          }}
        >
          下载 Markdown
        </button>
      </div>
      {state && <p className="estimate-line">{state}</p>}
    </section>
  );
}
