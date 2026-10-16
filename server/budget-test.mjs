import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-budget-test-"));
const features = path.join(root, "features");
fs.mkdirSync(features);

function compile(sourcePath, outputPath, replacements = []) {
  let source = fs.readFileSync(sourcePath, "utf8");
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  fs.writeFileSync(outputPath, compiled);
}

try {
  compile("src/types.ts", path.join(root, "types.mjs"));
  compile("src/features/ledger.ts", path.join(features, "ledger.mjs"), [["../types", "../types.mjs"]]);
  compile("src/features/budget.ts", path.join(features, "budget.mjs"), [
    ["../types", "../types.mjs"],
    ["./ledger", "./ledger.mjs"],
  ]);
  const budget = await import(`file://${path.join(features, "budget.mjs")}`);
  const trip = {
    title: "零预算测试",
    destination: "上海",
    overview: "",
    days: [{ date: "2026-10-01", theme: "免费行程", activities: [{
      time: "09:00", title: "公园", detail: "", location: "公园",
      estimatedCost: 0.01, durationMinutes: 60, type: "景点",
    }] }],
    tips: ["提示"],
  };
  const status = budget.budgetStatus(trip, 0, 1, 1);
  if (!status.over || status.remaining !== -0.01) throw new Error("zero-budget overflow was not detected");
  const picked = budget.pickWithinBudget(trip, null, 0);
  if (!picked.stillOver) throw new Error("zero-budget pick incorrectly reported success");
  console.log("Budget zero-limit regression test passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
