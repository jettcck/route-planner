import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(process.cwd(), ".trip-generation-test-"));
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
  compile("src/features/trip-generation.ts", path.join(features, "trip-generation.mjs"), [["../types", "../types.mjs"]]);
  const generation = await import(`file://${path.join(features, "trip-generation.mjs")}`);
  const request = {
    destination: "上海", startDate: "2026-10-01", days: 1, travelers: 2,
    budget: 1000, pace: "适中", interests: ["城市漫步"], notes: "",
  };
  const valid = { title: "上海", destination: "上海", overview: "", days: [{ date: "2026-10-01", theme: "城市漫步", activities: [{ time: "09:00", title: "外滩", detail: "", location: "外滩", estimatedCost: 100.005, durationMinutes: 60, type: "景点" }] }], tips: ["提示"] };
  const parsed = generation.parseTripContent(JSON.stringify(valid), request);
  if (parsed.destination !== request.destination || parsed.days.length !== 1) throw new Error("valid trip was rejected incorrectly");
  for (const changed of [
    { ...valid, destination: "杭州" },
    { ...valid, days: [{ ...valid.days[0], activities: [] }] },
    { ...valid, days: [{ ...valid.days[0], date: "2026-10-02" }] },
    { ...valid, days: [{ ...valid.days[0], activities: [{ ...valid.days[0].activities[0], estimatedCost: 1001 }] }] },
  ]) {
    if (!(() => { try { generation.parseTripContent(JSON.stringify(changed), request); return false; } catch { return true; } })()) {
      throw new Error("invalid AI trip was accepted");
    }
  }
  console.log("AI trip generation validation test passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
