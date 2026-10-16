import type { PlannerInput, Trip } from "../types";
import { estimatedTotal } from "./ledger";

export type BudgetStatus = {
  /** 全部同行者合计（与 estimatedCost 的口径一致）。 */
  total: number;
  /** 人均总额。 */
  average: number;
  /** 预算余额，负数代表超出。 */
  remaining: number;
  percent: number;
  over: boolean;
  perPersonPerDay: number;
};

export function budgetStatus(
  trip: Trip,
  budget: number,
  travelers: number,
  days?: number,
): BudgetStatus {
  const total = estimatedTotal(trip);
  const people = Math.max(1, travelers);
  const dayCount = Math.max(1, days ?? trip.days.length);
  return {
    total,
    average: total / people,
    remaining: budget - total,
    percent: budget > 0 ? Math.round((total / budget) * 100) : 0,
    // Zero is a valid budget input. Any non-zero estimated cost must still
    // be reported as over budget so the generator cannot silently accept a
    // paid itinerary while the user asked for a free plan.
    over: total > budget,
    perPersonPerDay: total / people / dayCount,
  };
}

/**
 * 超预算时追加给模型的修正指令。
 * 明确要求「按额度重排」而不是「减天数」，否则模型最爱砍行程深度。
 */
export function budgetFixNote(status: BudgetStatus, input: PlannerInput) {
  const target = Math.floor(input.budget * 0.95 * 100) / 100;
  const head = input.notes.trim();
  const rule = [
    `【必须修正】上一版所有 activities 的 estimatedCost 合计为 ¥${Math.round(status.total)}，`,
    `超出总预算 ¥${input.budget}。请重新排一版：`,
    `把合计压到 ¥${target} 以内（仍是全部 ${input.travelers} 位同行者的合计），`,
    `天数保持 ${input.days} 天不变；`,
    `优先削减付费项目、住宿标准与长途交通，把省钱做法写进 tips。`,
  ].join("");
  // The same 2,000-character notes limit applies to both generation attempts.
  // Reserve room for the correction instead of silently making retry invalid.
  const keptHead = head.slice(0, Math.max(0, 2_000 - rule.length - 1));
  return keptHead ? `${keptHead}\n${rule}` : rule;
}

export type BudgetPick = {
  trip: Trip;
  /** 是否用了重试那一版。 */
  adjusted: boolean;
  /** 最终仍然超预算。 */
  stillOver: boolean;
};

export function budgetPlanAdvice(status: BudgetStatus, input: PlannerInput) {
  if (input.budget <= 0) return "请先设置一个总预算，系统才能给出可执行的省钱方案。";
  if (!status.over && status.percent <= 85) {
    return "预算仍有余量，可优先留给临时交通、餐饮涨价和预约变更。";
  }
  if (!status.over) {
    return `当前已用预算 ${status.percent}%，建议预留至少 ${Math.round(input.budget * 0.15).toLocaleString("zh-CN")} 元机动金，不再增加付费项目。`;
  }
  const gap = Math.abs(status.remaining);
  const perPerson = Math.ceil(gap / Math.max(1, input.travelers));
  return [
    `还需压缩约 ${gap.toLocaleString("zh-CN")} 元（人均约 ${perPerson.toLocaleString("zh-CN")} 元）。`,
    "优先替换高价门票和包车，保留每天一个核心景点；住宿改为交通方便的经济型房型；短途改公共交通；餐饮采用一顿特色餐+一顿平价餐。",
    `不要删减旅行天数，先把方案压到预算的 95% 以内，并保留约 ${Math.round(input.budget * 0.05).toLocaleString("zh-CN")} 元缓冲。`,
  ].join("");
}

/** 首版超预算时，在首版与重排版之间取更贴近预算的一版。 */
export function pickWithinBudget(
  first: Trip,
  second: Trip | null,
  budget: number,
): BudgetPick {
  if (budget <= 0) {
    return {
      trip: first,
      adjusted: false,
      stillOver: estimatedTotal(first) > budget,
    };
  }
  const firstTotal = estimatedTotal(first);
  if (firstTotal <= budget) {
    return { trip: first, adjusted: false, stillOver: false };
  }
  if (!second) {
    return { trip: first, adjusted: false, stillOver: true };
  }
  const secondTotal = estimatedTotal(second);
  const useSecond = secondTotal < firstTotal;
  const chosen = useSecond ? second : first;
  return {
    trip: chosen,
    adjusted: useSecond,
    stillOver: estimatedTotal(chosen) > budget,
  };
}
