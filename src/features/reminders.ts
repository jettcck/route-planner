import type { Trip } from "../types";
import type { CurrentWeather, Weather } from "../weather";

export type Countdown = {
  status: "未出发" | "进行中" | "已结束";
  days: number;
  label: string;
  detail: string;
};

function atMidnight(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DAY = 24 * 60 * 60 * 1000;

/** 出发倒计时：未出发按天倒计，行程中给到第几天，结束后给出总天数。 */
export function tripCountdown(trip: Trip): Countdown {
  const dates = trip.days.map((day) => day.date).filter(Boolean).sort();
  const start = dates[0] ? atMidnight(dates[0]) : null;
  const end = dates[dates.length - 1] ? atMidnight(dates[dates.length - 1]) : null;
  if (!start || !end) {
    return { status: "未出发", days: 0, label: "日期待定", detail: "确定出发日期后可看到倒计时" };
  }
  const today = todayMidnight();
  const todayKey = localDateKey(today);
  const toStart = Math.round((start.getTime() - today.getTime()) / DAY);
  const toEnd = Math.round((end.getTime() - today.getTime()) / DAY);
  if (toStart > 0) {
    return {
      status: "未出发",
      days: toStart,
      label: `还有 ${toStart} 天出发`,
      detail: `共 ${trip.days.length} 天行程，出发前请核对预约与天气`,
    };
  }
  if (toEnd >= 0) {
    const scheduledIndex = dates.indexOf(todayKey);
    if (scheduledIndex < 0) {
      const nextDate = dates.find((date) => date > todayKey);
      return {
        status: "进行中",
        days: 0,
        label: "行程间隔",
        detail: nextDate ? `${nextDate} 有下一项安排，今天可休整或机动调整` : "今天没有预设安排，可休整或机动调整",
      };
    }
    const dayIndex = scheduledIndex + 1;
    return {
      status: "进行中",
      days: 0,
      label: `行程第 ${dayIndex} 天`,
      detail: `今天安排的行程可直接打卡记录`,
    };
  }
  return {
    status: "已结束",
    days: Math.abs(toEnd),
    label: `已结束 ${Math.abs(toEnd)} 天`,
    detail: `本次共 ${trip.days.length} 天，可在记账页结算花费`,
  };
}

export type Advisory = {
  level: "info" | "warn" | "danger";
  title: string;
  detail: string;
};

/** 由天气预报与行程内容推导出行提醒（带伞、防晒、防寒、雷雨避险等）。 */
export function weatherAdvisories(
  weather: Weather[],
  trip: Trip,
  current?: CurrentWeather,
): Advisory[] {
  const list: Advisory[] = [];
  const labels = weather.map((item) => item.label).join(" ");
  const rainy = weather.filter((item) => (item.rain ?? 0) >= 50);
  const stormy = /雷/.test(labels) || weather.some((item) => (item.code ?? 0) >= 95);
  const cold = weather.filter((item) => (item.min ?? 99) <= 5);
  const hot = weather.filter((item) => (item.max ?? -99) >= 33);
  const snowy = /雪/.test(labels);

  if (current) {
    const currentRain = (current.rain ?? 0) > 0 || (current.code ?? 0) >= 51;
    const currentStorm = (current.code ?? 0) >= 95;
    list.unshift({
      level: currentStorm ? "danger" : currentRain ? "warn" : "info",
      title: `当前天气：${current.label}${current.temperature === undefined ? "" : ` · ${Math.round(current.temperature)}°C`}`,
      detail: currentStorm
        ? "实时雷雨天气，先安排室内活动，避开山顶、索道、水边和空旷地带。"
        : currentRain
          ? "实时有降水，随身带伞并给户外活动准备室内备选。"
          : (current.temperature ?? 99) >= 33
            ? "实时高温，避开正午暴晒，补水并做好防晒。"
            : (current.temperature ?? -99) <= 5
              ? "实时低温，增加保暖层并注意早晚温差。"
              : "当前适合常规出行，建议根据实时变化调整户外安排。",
    });
  }

  if (stormy) {
    list.push({
      level: "danger",
      title: "有雷雨天气",
      detail: "雷雨时段避免山顶、索道、水上游览，把室内展馆调到当天优先。",
    });
  }
  if (rainy.length) {
    list.push({
      level: "warn",
      title: `${rainy.length} 天降水概率偏高`,
      detail: `集中在 ${rainy
        .map((item) => item.date.slice(5))
        .join("、")}，带好雨具与防水袋，户外行程准备备选方案。`,
    });
  }
  if (snowy) {
    list.push({
      level: "warn",
      title: "预报有降雪",
      detail: "注意路面结冰与景区临时关闭，自驾需确认是否要求防滑链。",
    });
  }
  if (cold.length) {
    list.push({
      level: "warn",
      title: "有低温天气",
      detail: `最低约 ${Math.min(...cold.map((item) => item.min ?? 0))}°C，准备保暖内层与外套。`,
    });
  }
  if (hot.length) {
    list.push({
      level: "warn",
      title: "有高温时段",
      detail: `最高约 ${Math.max(...hot.map((item) => item.max ?? 0))}°C，把户外行程放到上午或傍晚，注意补水与防晒。`,
    });
  }

  const outdoorHeavy = trip.days.some((day) =>
    day.activities.some((item) =>
      /登山|徒步|漂流|水上|露营|索道/.test(`${item.type}${item.title}`),
    ),
  );
  if (outdoorHeavy && (rainy.length || stormy)) {
    list.push({
      level: "warn",
      title: "户外项目遇降雨",
      detail: "行程含登山/水上项目，建议提前确认景区是否停运，并保留改期余地。",
    });
  }

  const firstDay = trip.days[0];
  if (firstDay && firstDay.activities.length >= 5) {
    list.push({
      level: "info",
      title: "首日安排较满",
      detail: "抵达当天通常有交通与入住耗时，建议把首日安排压缩 1–2 项。",
    });
  }
  if (!list.length) {
    list.push({
      level: "info",
      title: "暂无明显风险天气",
      detail: "出发前 1 天再刷新一次预报，山区与沿海天气变化更快。",
    });
  }
  return list;
}

/** 行前待办模板，勾选状态本地保存。 */
export const prepTodos: { id: string; label: string; hint: string }[] = [
  { id: "id", label: "核对身份证/护照有效期", hint: "过期无法乘车与入园" },
  { id: "ticket", label: "预订往返交通", hint: "热门线路越早越便宜" },
  { id: "hotel", label: "确认住宿与入住时间", hint: "夜间到达先确认前台时间" },
  { id: "spot", label: "预约景点门票", hint: "多数博物馆需实名分时预约" },
  { id: "offline", label: "下载离线地图与离线资料", hint: "山区与地铁里常无信号" },
  { id: "network", label: "准备流量卡/漫游或随身 WiFi", hint: "境外出行尤其重要" },
  { id: "insurance", label: "购买旅行意外险", hint: "含医疗与行程取消条款" },
  { id: "money", label: "准备现金与可用银行卡", hint: "偏远地区可能无法扫码" },
  { id: "medicine", label: "备好个人常用药", hint: "按行程天数加量" },
  { id: "share", label: "把行程发给同行人与家人", hint: "应急时能快速定位" },
  { id: "weather", label: "出发前 1 天复查天气与公告", hint: "景区可能临时关闭" },
];

/** 清洗行前待办的本地勾选状态，忽略未知或损坏的键。 */
export function sanitizePrepState(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = Object.create(null) as Record<string, boolean>;
  for (const [key, checked] of Object.entries(value).slice(0, 100)) {
    if (!key || key.length > 100 || key === "__proto__" || key === "constructor" || key === "prototype" || typeof checked !== "boolean") continue;
    result[key] = checked;
  }
  return result;
}
