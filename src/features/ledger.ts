import type { Trip } from "../types";

export const expenseCategories = [
  "交通",
  "门票",
  "餐饮",
  "住宿",
  "购物",
  "其他",
] as const;
export type ExpenseCategory = (typeof expenseCategories)[number];

export type CurrencyCode = "CNY" | "HKD" | "USD" | "EUR" | "JPY" | "THB" | "KRW";

export const currencies: { code: CurrencyCode; label: string; rate: number }[] = [
  { code: "CNY", label: "人民币 ¥", rate: 1 },
  { code: "HKD", label: "港币 HK$", rate: 0.92 },
  { code: "USD", label: "美元 $", rate: 7.1 },
  { code: "EUR", label: "欧元 €", rate: 7.7 },
  { code: "JPY", label: "日元 ¥", rate: 0.048 },
  { code: "THB", label: "泰铢 ฿", rate: 0.2 },
  { code: "KRW", label: "韩元 ₩", rate: 0.0052 },
];

export type Expense = {
  id: string;
  date: string;
  category: ExpenseCategory;
  title: string;
  amount: number;
  currency: CurrencyCode;
  /** 兑人民币汇率，默认取参考值，可手工改。 */
  rate: number;
  paidBy: string;
  /** 参与分摊的人数，用于兼容旧数据。 */
  shares: number;
  /** 实际参与分摊的成员；缺失时按旧版 shares 规则兼容。 */
  participants?: string[];
};

export const defaultPayer = "我";

const currencyCodes = new Set<CurrencyCode>(currencies.map((item) => item.code));
const categoryCodes = new Set<ExpenseCategory>(expenseCategories);
export const MAX_EXPENSES = 1_000;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** 清洗旧版本或手工篡改的本地账单，避免坏记录让汇总组件抛异常。 */
export function sanitizeExpenses(value: unknown): Expense[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Expense[] = [];
  const ids = new Set<string>();
  for (const entry of value.slice(0, MAX_EXPENSES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Partial<Expense>;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 120 || ids.has(item.id)) continue;
    if (!isCalendarDate(item.date)) continue;
    if (typeof item.category !== "string" || !categoryCodes.has(item.category as ExpenseCategory)) continue;
    if (typeof item.title !== "string" || item.title.trim().length === 0 || item.title.length > 160) continue;
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > 10_000_000) continue;
    if (typeof item.currency !== "string" || !currencyCodes.has(item.currency as CurrencyCode)) continue;
    if (typeof item.rate !== "number" || !Number.isFinite(item.rate) || item.rate < 0 || item.rate > 1_000_000) continue;
    if (typeof item.paidBy !== "string" || item.paidBy.length > 120) continue;
    if (typeof item.shares !== "number" || !Number.isInteger(item.shares) || item.shares < 1 || item.shares > 100) continue;
    if (item.participants !== undefined && (!Array.isArray(item.participants) || item.participants.length > 100 ||
      item.participants.some((name) => typeof name !== "string" || name.length === 0 || name.length > 120))) continue;
    ids.add(item.id);
    result.push({
      id: item.id,
      date: item.date,
      category: item.category as ExpenseCategory,
      title: item.title.trim(),
      amount: item.amount,
      currency: item.currency as CurrencyCode,
      rate: item.rate,
      paidBy: item.paidBy.trim() || defaultPayer,
      shares: item.shares,
      participants: item.participants ? [...new Set(item.participants)] : undefined,
    });
  }
  return result;
}

export function defaultRate(code: CurrencyCode) {
  return currencies.find((item) => item.code === code)?.rate ?? 1;
}

/** 折算成人民币，保留两位小数。 */
export function toCny(expense: Expense) {
  const amount = Number(expense.amount);
  const rate = Number(expense.rate);
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || amount < 0 || rate < 0) return 0;
  return Math.round(amount * rate * 100) / 100;
}

export type LedgerSummary = {
  total: number;
  count: number;
  perPerson: number;
  /**
   * 真正参与账目的人数（有垫付或有分摊）。
   * 规划人数（`defaultMembers` 生成「同伴2」这类占位名）与手工填写的参与人
   * 会合并进同一个 roster，两者名字不同时 roster 会虚高——直接拿
   * `balances.length` 当"人均人数"会出现"人均（11 人）"而实际只有 6 人同行。
   */
  activeMembers: number;
  remaining: number;
  usedPercent: number;
  byCategory: { category: ExpenseCategory; amount: number; percent: number }[];
  byDay: { date: string; amount: number }[];
  balances: { name: string; paid: number; owed: number; balance: number }[];
  settlements: { from: string; to: string; amount: number }[];
};

export function defaultMembers(travelers: number) {
  const count = Math.max(1, travelers);
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? defaultPayer : `同伴${index + 1}`,
  );
}

/**
 * 汇总支出：总额、分类占比、人均、与预算差额，并给出 AA 结算方案。
 * 分摊模型：每笔支出由 paidBy 全额垫付，金额按 shares 人在成员列表里均摊；
 * 结算用贪心抵消最大债权与最大债务，转账笔数接近最少。
 */
export function summarize(
  expenses: Expense[],
  budget: number,
  members: string[],
): LedgerSummary {
  const roster = members.length ? [...new Set(members)] : [defaultPayer];
  for (const expense of expenses) {
    const payer = expense.paidBy || defaultPayer;
    if (!roster.includes(payer)) roster.push(payer);
    // A later change to the planning headcount must not erase historical
    // participants or redistribute their debts to the remaining members.
    const participants = expense.participants?.length
      ? expense.participants
      : defaultMembers(expense.shares);
    for (const name of participants) {
      if (!roster.includes(name)) roster.push(name);
    }
  }
  const total = expenses.reduce((sum, item) => sum + toCny(item), 0);
  const categoryMap = new Map<ExpenseCategory, number>();
  const dayMap = new Map<string, number>();
  const paid = new Map<string, number>(roster.map((name) => [name, 0]));
  const owed = new Map<string, number>(roster.map((name) => [name, 0]));

  for (const expense of expenses) {
    const cny = toCny(expense);
    const cents = Math.round(cny * 100);
    const payer = expense.paidBy || defaultPayer;
    categoryMap.set(
      expense.category,
      (categoryMap.get(expense.category) ?? 0) + cny,
    );
    dayMap.set(expense.date, (dayMap.get(expense.date) ?? 0) + cny);
    paid.set(payer, (paid.get(payer) ?? 0) + cents);
    const shares = Math.min(
      roster.length,
      Math.max(1, Math.round(expense.shares) || 1),
    );
    const selected = expense.participants?.filter((name) => roster.includes(name));
    const participants = selected?.length
      ? [...new Set(selected)]
      : roster.slice(0, shares);
    const safeParticipants = participants.length ? participants : [defaultPayer];
    // Split integer cents, assigning remainder cents in participant order.
    // Fractional yuan rounding can create or lose money (e.g. ¥0.01 / 3).
    const part = Math.floor(cents / safeParticipants.length);
    const remainder = cents % safeParticipants.length;
    for (const [index, name] of safeParticipants.entries()) {
      owed.set(name, (owed.get(name) ?? 0) + part + (index < remainder ? 1 : 0));
    }
  }

  const travelersSafe = Math.max(1, roster.length);
  const round = (value: number) => Math.round(value * 100) / 100;
  const balances = roster
    .map((name) => ({
      name,
      paid: (paid.get(name) ?? 0) / 100,
      owed: (owed.get(name) ?? 0) / 100,
      balance: ((paid.get(name) ?? 0) - (owed.get(name) ?? 0)) / 100,
    }))
    .sort((a, b) => b.balance - a.balance);

  const creditors = balances
    .filter((item) => item.balance > 0)
    .map((item) => ({ name: item.name, amount: Math.round(item.balance * 100) }));
  const debtors = balances
    .filter((item) => item.balance < 0)
    .map((item) => ({ name: item.name, amount: Math.round(-item.balance * 100) }));
  const settlements: { from: string; to: string; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) {
      settlements.push({
        from: debtors[i].name,
        to: creditors[j].name,
        amount: amount / 100,
      });
    }
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount === 0) i += 1;
    if (creditors[j].amount === 0) j += 1;
  }

  const byCategory = [...categoryMap.entries()]
    .map(([category, amount]) => ({
      category,
      amount: round(amount),
      percent: total ? Math.round((amount / total) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  const byDay = [...dayMap.entries()]
    .map(([date, amount]) => ({ date, amount: round(amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 只把真正有钱动过的人算进人均分母：既没垫付也没分摊的成员
  // （典型来源是规划人数生成的「同伴N」占位名）与本次账目无关，
  // 计入分母会把"人均"算小，看起来像账目出错了。
  const activeMemberCount = balances.filter((item) => item.paid !== 0 || item.owed !== 0).length;
  const perPersonDivisor = Math.max(1, activeMemberCount || travelersSafe);

  return {
    total: round(total),
    count: expenses.length,
    perPerson: round(total / perPersonDivisor),
    activeMembers: perPersonDivisor,
    remaining: round(budget - total),
    usedPercent: budget > 0 ? Math.round((total / budget) * 100) : 0,
    byCategory,
    byDay,
    balances,
    settlements,
  };
}

/** 从行程里推断「本趟总共估了多少」，用于和实付做对照。 */
export function estimatedTotal(trip: Trip) {
  return trip.days.reduce(
    (sum, day) =>
      sum +
      day.activities.reduce((part, item) => part + Math.round(item.estimatedCost * 100), 0),
    0,
  ) / 100;
}
