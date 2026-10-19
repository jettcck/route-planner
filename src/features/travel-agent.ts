import type { Trip } from "../types";
import { activitySchema, type Activity } from "../types";
import type { Advisory } from "./reminders";
import type { Issue } from "./health";
import type { Weather } from "../weather";

export type TravelAgentAction = "focus-day" | "add-reminder" | "refresh-weather" | "hotel-search" | "ticket-search";

export type TravelAgentSuggestion = {
  id: string;
  level: "risk" | "warn" | "info";
  title: string;
  detail: string;
  action: TravelAgentAction;
  day?: number;
  reminder?: string;
  query?: string;
};

export type AgentAction =
  | { type: "reschedule_activity"; day: number; index: number; time: string; reason: string }
  | { type: "replace_activity"; day: number; index: number; activity: Activity; reason: string }
  | { type: "add_todo"; text: string; reason: string };
export type AgentProposal = { summary: string; warnings: string[]; actions: AgentAction[] };

export function parseAgentProposal(value: unknown): AgentProposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 600 ||
    !Array.isArray(item.warnings) || item.warnings.length > 8 || item.warnings.some((v) => typeof v !== "string" || !v.trim() || v.length > 300) ||
    !Array.isArray(item.actions) || item.actions.length > 6) return undefined;
  const actions: AgentAction[] = [];
  for (const raw of item.actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const action = raw as Record<string, unknown>;
    if (typeof action.reason !== "string" || !action.reason.trim() || action.reason.length > 400) return undefined;
    if (action.type === "add_todo") {
      if (typeof action.text !== "string" || !action.text.trim() || action.text.length > 90) return undefined;
      actions.push({ type: "add_todo", text: action.text.trim(), reason: action.reason.trim() });
      continue;
    }
    const dayIndex = action.day;
    const activityIndex = action.index;
    if ((action.type !== "reschedule_activity" && action.type !== "replace_activity") ||
      !Number.isInteger(dayIndex) || !Number.isInteger(activityIndex) || (dayIndex as number) < 0 || (dayIndex as number) > 30 || (activityIndex as number) < 0 || (activityIndex as number) > 99) return undefined;
    if (action.type === "reschedule_activity") {
      if (typeof action.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(action.time)) return undefined;
      actions.push({ type: action.type, day: action.day as number, index: action.index as number, time: action.time, reason: action.reason.trim() });
    } else {
      const checked = activitySchema.safeParse(action.activity);
      if (!checked.success) return undefined;
      actions.push({ type: action.type, day: action.day as number, index: action.index as number, activity: checked.data, reason: action.reason.trim() });
    }
  }
  return { summary: item.summary.trim(), warnings: (item.warnings as string[]).map((v) => v.trim()), actions };
}

export function validateAgentActionForTrip(trip: Trip, action: AgentAction, completed: { day: number; index: number }[], budget: number, reminders: string[]) {
  if (action.type === "add_todo") {
    if (reminders.includes(action.text)) return "该待办已存在";
    if (reminders.length >= 20) return "行程管家待办已达 20 项上限";
    return "";
  }
  const day = trip.days[action.day];
  const original = day?.activities[action.index];
  if (!original) return "调整目标已不存在，请重新分析";
  if (completed.some((item) => item.day === action.day && item.index === action.index)) return "已打卡的安排不能由管家修改";
  const candidate = action.type === "reschedule_activity" ? { ...original, time: action.time } : action.activity;
  if ([original, candidate].some((item) => /交通|住宿|酒店|民宿|客栈|旅馆|入住|退房|航班|飞机|高铁|火车|动车|机票|车票|轮渡|租车/.test(`${item.type} ${item.title} ${item.detail}`))) return "交通与住宿安排请手动核对预约后修改";
  const [h, m] = candidate.time.split(":").map(Number); const start = h * 60 + m; const end = start + candidate.durationMinutes;
  if (end > 1440) return "调整后的安排超过当天时间范围";
  if (day.activities.some((item, index) => index !== action.index && start < (Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3))) + item.durationMinutes && Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3)) < end)) return "调整后的安排与其他活动重叠";
  const before = trip.days.reduce((sum, d) => sum + d.activities.reduce((s, item) => s + item.estimatedCost, 0), 0);
  const after = before - original.estimatedCost + candidate.estimatedCost;
  if (after > budget && after >= before) return "方案会增加超预算风险";
  return "";
}

/** 调用方传进来的行程上下文，只取提案校验需要的字段。 */
export type AgentProposalContext = {
  trip: Trip;
  budget: number;
  completed: { day: number; index: number }[];
  reminders: string[];
};

/**
 * 解析并**按当前行程**校验 AI 提案。
 *
 * `parseAgentProposal` 只校验结构与字段范围（day ≤ 30、index ≤ 99），
 * 但模型完全可能给一个只有 2 天的行程排出 day=5 的改动——那种动作一旦被
 * 确认执行，就会去访问并不存在的 `trip.days[5]`，轻则静默失效，重则抛错。
 * 所以这里逐条过 `validateAgentActionForTrip`，丢弃不可执行的动作；
 * 一条都不剩时整份提案作废，由调用方提示重试，而不是给用户一个空提案。
 */
export function validateAgentProposal(value: unknown, context: AgentProposalContext): AgentProposal | undefined {
  const parsed = parseAgentProposal(value);
  if (!parsed) return undefined;
  const actions = parsed.actions.filter((action) =>
    validateAgentActionForTrip(
      context.trip,
      action,
      context.completed,
      context.budget,
      context.reminders,
    ) === "",
  );
  if (!actions.length) return undefined;
  return { ...parsed, actions };
}

export function sanitizeAgentReminders(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, 240);
    if (text && !result.includes(text)) result.push(text);
    if (result.length >= 20) break;
  }
  return result;
}

function reminderForIssue(issue: Issue) {
  if (/预算/.test(issue.title)) return "出发前再次核对预算，预留至少 15% 机动金";
  if (/住宿/.test(issue.title)) return "确认每晚住宿地址、入住时间和取消政策";
  if (/用餐/.test(issue.title)) return "为当天午餐和晚餐预留时间与预算";
  if (/重复地点/.test(issue.title)) return "确认重复地点是否有意重游，避免重复通勤";
  return `处理行程问题：${issue.title}`;
}

/**
 * The first travel agent is deliberately deterministic. It uses data already
 * available on the device, so it remains useful without an AI key and never
 * changes a trip without an explicit user action.
 */
export function buildTravelAgentSuggestions({
  trip,
  weather,
  advisories,
  issues,
  weatherStale,
}: {
  trip: Trip;
  weather: Weather[];
  advisories: Advisory[];
  issues: Issue[];
  weatherStale: boolean;
}): TravelAgentSuggestion[] {
  const suggestions: TravelAgentSuggestion[] = [];
  const seen = new Set<string>();
  const agentLevel = (level: Advisory["level"]): TravelAgentSuggestion["level"] =>
    level === "danger" ? "risk" : level;
  const add = (suggestion: TravelAgentSuggestion) => {
    if (seen.has(suggestion.id)) return;
    seen.add(suggestion.id);
    suggestions.push(suggestion);
  };

  for (const issue of issues.filter((item) => item.level !== "info").slice(0, 3)) {
    if (issue.day !== null) {
      add({
        id: `issue-day-${issue.day}-${issue.title}`,
        level: issue.level,
        title: issue.title,
        detail: issue.detail,
        action: "focus-day",
        day: issue.day,
      });
    } else {
      add({
        id: `issue-reminder-${issue.title}`,
        level: issue.level,
        title: issue.title,
        detail: issue.detail,
        action: "add-reminder",
        reminder: reminderForIssue(issue),
      });
    }
  }

  const hasLodging = trip.days.some((day) => day.activities.some((item) =>
    /住宿|酒店|民宿|客栈|旅馆|入住|退房/.test(`${item.type}${item.title}${item.location}`),
  ));
  if (!hasLodging) {
    add({
      id: "hotel-search",
      level: "warn",
      title: "行程里还没有住宿安排",
      detail: "先按目的地和入住日期核对酒店位置、入住时间、取消政策与总价；管家不会代替你付款。",
      action: "hotel-search",
      query: "酒店",
      reminder: "确认住宿地址、入住时间、取消政策与订单凭证",
    });
  }

  const hasTransport = trip.days.some((day) => day.activities.some((item) =>
    /航班|飞机|机场|高铁|火车|动车|车站|火车站|机票|车票|交通/.test(`${item.type}${item.title}${item.location}`),
  ));
  if (!hasTransport) {
    add({
      id: "ticket-search",
      level: "info",
      title: "建议提前核对往返车票或机票",
      detail: "热门线路建议尽早确认出发站、到达站、证件信息和退改规则；这里只打开官方购票入口，不自动下单。",
      action: "ticket-search",
      reminder: "核对往返车票/机票、出发站、证件信息和退改规则",
    });
  }

  const weatherRisk = advisories.find((item) => item.level === "danger" || item.level === "warn");
  if (weatherRisk) {
    const riskyDate = weather.find((item) =>
      item.rain !== undefined && item.rain >= 60,
    )?.date;
    const day = riskyDate ? trip.days.findIndex((item) => item.date === riskyDate) : -1;
    if (day >= 0) {
      add({
        id: `weather-day-${riskyDate}`,
        level: agentLevel(weatherRisk.level),
        title: weatherRisk.title,
        detail: weatherRisk.detail,
        action: "focus-day",
        day,
      });
    } else {
      add({
        id: "weather-refresh",
        level: agentLevel(weatherRisk.level),
        title: weatherRisk.title,
        detail: weatherRisk.detail,
        action: "refresh-weather",
      });
    }
  }

  if (weatherStale || !weather.length) {
    add({
      id: "refresh-weather",
      level: "info",
      title: "天气数据需要刷新",
      detail: "行程管家会先更新天气，再判断户外安排是否需要调整。",
      action: "refresh-weather",
    });
  }

  if (!suggestions.length) {
    add({
      id: "agent-refresh",
      level: "info",
      title: "当前没有明显风险",
      detail: "出发前一天再检查一次天气和景区公告，行程会更稳妥。",
      action: "refresh-weather",
    });
  }
  return suggestions.slice(0, 4);
}
