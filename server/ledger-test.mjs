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

console.log("Ledger rounding and participant test passed");
