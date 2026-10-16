import { plannerInputSchema, tripSchema, type PlannerInput } from "../types";

/** Validate model output before it can replace the saved trip. */
export function parseTripContent(raw: string, request: PlannerInput) {
  if (!plannerInputSchema.safeParse(request).success) {
    throw new Error("规划条件无效，请检查日期、天数、人数和预算");
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("AI 返回的内容不是有效 JSON，请重试");
  }
  const checked = tripSchema.safeParse(parsed);
  if (!checked.success) throw new Error("AI 返回的行程字段不完整或格式不正确，请重试");
  const result = checked.data;
  if (result.destination !== request.destination.trim()) {
    // Relabelling a trip cannot fix activities belonging to a different city.
    throw new Error("AI 返回的目的地与设置不一致，请重试");
  }
  if (result.days.length !== request.days) throw new Error("AI 返回的行程天数与设置不符，请重试");
  const start = new Date(`${request.startDate}T00:00:00Z`);
  const expectedDates = Array.from({ length: request.days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  if (result.days.some((day, index) => day.date !== expectedDates[index])) {
    throw new Error("AI 返回的行程日期与出发日期不一致，请重试");
  }
  if (result.days.some((day) => !day.activities.length)) {
    throw new Error("AI 返回的行程存在空白日期，请重试");
  }
  const estimatedTotal = result.days.reduce(
    (total, day) => total + day.activities.reduce((dayTotal, activity) => dayTotal + activity.estimatedCost, 0),
    0,
  );
  // The prompt describes estimatedCost as the total for all travellers, but
  // model output can still drift. Never let an over-budget plan replace the
  // user's saved trip; the caller can retry or lower the requested scope.
  if (!Number.isFinite(estimatedTotal) || estimatedTotal > request.budget) {
    throw new Error("AI 返回的行程超出预算，请重试或提高预算");
  }
  return result;
}
