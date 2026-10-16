import type { PlannerInput, Trip } from "../types";
import type { Weather } from "../weather";
import { checkInStats, type CheckInMap } from "./checkin";
import { summarize, type Expense, estimatedTotal } from "./ledger";
import { invoke, isTauri } from "@tauri-apps/api/core";

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 生成可复制的纯文本行程，便于分享给同行人或存档。 */
export function tripToMarkdown(
  trip: Trip,
  input: PlannerInput,
  weather: Weather[],
  expenses: Expense[],
  checkIns: CheckInMap,
) {
  const lines: string[] = [];
  lines.push(`# ${trip.title}`);
  lines.push("");
  lines.push(`- 目的地：${trip.destination}`);
  lines.push(`- 天数：${trip.days.length} 天`);
  lines.push(`- 出行人数：${input.travelers} 人`);
  lines.push(`- 预算：¥${input.budget}`);
  lines.push(`- 节奏：${input.pace}`);
  if (input.interests.length) lines.push(`- 偏好：${input.interests.join("、")}`);
  lines.push("");
  lines.push(trip.overview);
  lines.push("");

  trip.days.forEach((day, dayIndex) => {
    lines.push(`## 第 ${dayIndex + 1} 天 · ${dateLabel(day.date)} · ${day.theme}`);
    const forecast = weather.find((item) => item.date === day.date);
    if (forecast) lines.push(`> 天气：${forecast.summary}`);
    day.activities.forEach((item) => {
      lines.push(
        `- **${item.time}** ${item.title}（${item.location || "地点待定"}，${item.durationMinutes} 分钟，${
          item.estimatedCost ? `¥${item.estimatedCost}` : "免费"
        }）`,
      );
      if (item.detail) lines.push(`  - ${item.detail}`);
    });
    lines.push("");
  });

  if (trip.tips.length) {
    lines.push("## 出行提示");
    trip.tips.forEach((tip) => lines.push(`- ${tip}`));
    lines.push("");
  }

  const summary = summarize(expenses, input.budget, [
    "我",
    ...Array.from({ length: Math.max(0, input.travelers - 1) }, (_, index) => `同伴${index + 1}`),
  ]);
  lines.push("## 花费");
  lines.push(`- 估算：¥${Math.round(estimatedTotal(trip))}`);
  if (expenses.length) {
    lines.push(`- 实付：¥${summary.total}`);
    summary.byCategory.forEach((item) =>
      lines.push(`  - ${item.category}：¥${item.amount}（${item.percent}%）`),
    );
    lines.push(`- 人均：¥${summary.perPerson}`);
  } else {
    lines.push("- 实付：暂无记账");
  }
  lines.push("");

  const stats = checkInStats(trip, checkIns);
  lines.push("## 打卡");
  lines.push(`- 已完成 ${stats.done} / ${stats.total} 项（${stats.percent}%）`);
  lines.push("");
  lines.push("---");
  lines.push("由「途迹 Route」生成，费用与营业信息请以官方渠道为准。");
  return lines.join("\n");
}

/** 复制文本：优先用剪贴板 API，失败时回落到隐藏输入框方案。 */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试回落方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export async function downloadText(filename: string, text: string, type: string) {
  if (isTauri() && /Android/i.test(navigator.userAgent)) {
    try {
      // The Rust command argument is `file_type`, which Tauri exposes to JS
      // as camelCase. The Rust bridge then maps it to the native `type` field.
      await invoke("plugin:file-share|share_text", { filename, text, fileType: type });
      return;
    } catch {
      // Fall through to Web Share when the native chooser is unavailable.
    }
  }
  const file = new File([text], filename, { type });
  if (/Android/i.test(navigator.userAgent) && typeof navigator.share === "function") {
    try {
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename, text: "途迹导出文件" });
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
