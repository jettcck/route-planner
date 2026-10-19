import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/features/ledger.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const ledger = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const expenses = [
  { id: "a", date: "2026-10-08", category: "餐饮", title: "小吃", amount: 0.01, currency: "CNY", rate: 1, paidBy: "我", shares: 3 },
  { id: "b", date: "2026-10-08", category: "交通", title: "车票", amount: 10, currency: "CNY", rate: 1, paidBy: "同伴3", shares: 3, participants: ["我", "同伴2", "同伴3"] },
];
const summary = ledger.summarize(expenses, 100, ["我", "同伴2"]);
if (summary.total !== 10.01) throw new Error(`unexpected total: ${summary.total}`);
if (!summary.balances.some((item) => item.name === "同伴3")) throw new Error("historical participant was dropped");
const settlementTotal = summary.settlements.reduce((sum, item) => sum + item.amount, 0);
const debtTotal = summary.balances.filter((item) => item.balance < 0).reduce((sum, item) => sum - item.balance, 0);
if (settlementTotal !== debtTotal) throw new Error("settlements lost fractional cents");

// 人均分母只算真正有钱动过的人：
// 规划 6 人会生成「同伴2…同伴6」占位名，而手工参与者用的是真实姓名，
// 两套名字合并后 roster 会虚高到 11。若直接拿 balances.length 当分母，
// 界面就会显示"人均（11 人）"，金额被算小三成——看起来像账目出错。
const mixed = [
  { id: "m1", date: "2026-10-06", category: "交通", title: "长途大巴", amount: 1080, currency: "CNY", rate: 1, paidBy: "我", shares: 6, participants: ["我", "小李", "小王", "小张", "老陈", "阿敏"] },
  { id: "m2", date: "2026-10-06", category: "住宿", title: "客栈", amount: 2400, currency: "CNY", rate: 1, paidBy: "我", shares: 6, participants: ["我", "小李", "小王", "小张", "老陈", "阿敏"] },
];
// 规划人数 6 → defaultMembers 构造出「我/同伴2…同伴6」，与上面 6 个真实姓名并存
const planningMembers = ["我", "同伴2", "同伴3", "同伴4", "同伴5", "同伴6"];
const mixedSummary = ledger.summarize(mixed, 6000, planningMembers);
if (mixedSummary.balances.length <= 6) {
  throw new Error(`roster 应包含规划占位名，实际 ${mixedSummary.balances.length}`);
}
if (mixedSummary.activeMembers !== 6) {
  throw new Error(`人均人数应按实际参与者 6 人计算，实际 ${mixedSummary.activeMembers}`);
}
if (Math.round(mixedSummary.perPerson) !== Math.round(3480 / 6)) {
  throw new Error(`人均金额错误：${mixedSummary.perPerson}，期望 ${Math.round(3480 / 6)}`);
}

console.log("Ledger rounding and participant test passed");
