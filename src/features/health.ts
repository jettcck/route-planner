import type { Trip } from "../types";
import type { Weather } from "../weather";

export type IssueLevel = "risk" | "warn" | "info";

export type Issue = {
  level: IssueLevel;
  title: string;
  detail: string;
  /** 0 起算的天序号；行程级问题为 null。 */
  day: number | null;
};

function minutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 行程体检：在不联网、无坐标的前提下，用时间轴与文本做可解释的合理性检查。
 * 只报能被验证的问题，不猜测实时路况与营业时间。
 */
export function auditTrip(
  trip: Trip,
  weather: Weather[],
  budget: number,
): Issue[] {
  const issues: Issue[] = [];
  const estimated = trip.days.reduce(
    (sum, day) =>
      sum +
      day.activities.reduce((part, item) => part + item.estimatedCost, 0),
    0,
  );

  trip.days.forEach((day, dayIndex) => {
    const items = day.activities;
    const dayLabel = `第 ${dayIndex + 1} 天`;

    if (!items.length) {
      issues.push({
        level: "warn",
        title: `${dayLabel}还没有安排`,
        detail: "空白的一天可以先放一个主目标，其余时间留给机动。",
        day: dayIndex,
      });
    }

    let totalMinutes = 0;
    let previousEnd: number | null = null;
    items.forEach((item, index) => {
      const start = minutes(item.time);
      totalMinutes += Math.max(0, item.durationMinutes);
      if (start !== null && previousEnd !== null && start < previousEnd) {
        issues.push({
          level: "risk",
          title: `${dayLabel}时间有重叠`,
          detail: `「${items[index - 1]?.title}」结束时间已超过「${item.title}」的开始时间 ${item.time}。`,
          day: dayIndex,
        });
      }
      if (start !== null) {
        previousEnd = Math.max(previousEnd ?? 0, start + Math.max(0, item.durationMinutes));
      }
    });

    if (totalMinutes > 12 * 60) {
      issues.push({
        level: "risk",
        title: `${dayLabel}安排超过 12 小时`,
        detail: `当天累计 ${Math.round(totalMinutes / 60)} 小时，赶景点会牺牲体验，建议删减或拆到其他天。`,
        day: dayIndex,
      });
    } else if (totalMinutes > 10 * 60) {
      issues.push({
        level: "warn",
        title: `${dayLabel}偏满`,
        detail: `当天累计 ${Math.round(totalMinutes / 60)} 小时，建议留出 1 小时机动。`,
        day: dayIndex,
      });
    }

    if (items.length > 6) {
      issues.push({
        level: "warn",
        title: `${dayLabel}景点数量偏多`,
        detail: `一天 ${items.length} 项，通勤与排队会明显拉长，5 项以内更从容。`,
        day: dayIndex,
      });
    }

    const seen = new Set<string>();
    items.forEach((item) => {
      const key = (item.location || item.title).trim();
      if (!key) return;
      if (seen.has(key)) {
        issues.push({
          level: "info",
          title: `${dayLabel}有重复地点`,
          detail: `「${key}」在同一天出现两次，可以合并成一次停留。`,
          day: dayIndex,
        });
      }
      seen.add(key);
    });

    const spots = new Set(
      items.map((item) => (item.location || item.title).trim()).filter(Boolean),
    );
    if (spots.size >= 6) {
      issues.push({
        level: "warn",
        title: `${dayLabel}跨地点较多`,
        detail: `当天涉及 ${spots.size} 个地点，按城市通勤估算需要预留 2 小时以上交通时间。`,
        day: dayIndex,
      });
    }

    const hasMeal = items.some((item) =>
      /餐|吃|美食|小吃|夜市|饭/.test(`${item.type}${item.title}${item.detail}`),
    );
    if (items.length >= 3 && !hasMeal) {
      issues.push({
        level: "info",
        title: `${dayLabel}没有安排用餐`,
        detail: "午饭和晚饭需要占 1–1.5 小时，建议直接写进时间轴。",
        day: dayIndex,
      });
    }

    const forecast = weather.find((item) => item.date === day.date);
    if (forecast && (forecast.rain ?? 0) >= 60) {
      const outdoor = items.filter((item) =>
        /登山|徒步|水上|漂流|索道|露营|沙滩/.test(`${item.type}${item.title}`),
      );
      if (outdoor.length) {
        issues.push({
          level: "risk",
          title: `${dayLabel}户外项目遇降雨`,
          detail: `降水概率 ${forecast.rain}%，涉及「${outdoor
            .map((item) => item.title)
            .join("、")}」，建议准备室内备选。`,
          day: dayIndex,
        });
      }
    }
  });

  if (budget > 0 && estimated > budget) {
    issues.push({
      level: "risk",
      title: "费用估算超出预算",
      detail: `行程估算 ¥${Math.round(estimated).toLocaleString("zh-CN")}，超出预算 ¥${Math.round(
        estimated - budget,
      ).toLocaleString("zh-CN")}，可替换部分付费项目。`,
      day: null,
    });
  } else if (budget > 0 && estimated > budget * 0.85) {
    issues.push({
      level: "warn",
      title: "预算接近上限",
      detail: "估算已用到预算的 85% 以上，还没算购物与临时交通，建议留出余量。",
      day: null,
    });
  }

  if (trip.days.length >= 2) {
    const hasLodging = trip.days.some((day) =>
      day.activities.some((item) =>
        /住宿|酒店|民宿|客栈|旅馆|入住/.test(
          `${item.type}${item.title}${item.location}`,
        ),
      ),
    );
    if (!hasLodging) {
      issues.push({
        level: "warn",
        title: "行程里没有住宿安排",
        detail: "多日行程建议把入住与退房写进时间轴，避免当天临时找房。",
        day: null,
      });
    }
  }

  const allLocations = trip.days.flatMap((day) =>
    day.activities.map((item) => (item.location || item.title).trim()),
  );
  const duplicated = allLocations.filter(
    (item, index) => item && allLocations.indexOf(item) !== index,
  );
  if (new Set(duplicated).size) {
    issues.push({
      level: "info",
      title: "整程有重复地点",
      detail: `以下地点出现多次，可确认是否有意重游：${[...new Set(duplicated)]
        .slice(0, 4)
        .join("、")}。`,
      day: null,
    });
  }

  if (!issues.length) {
    issues.push({
      level: "info",
      title: "行程结构合理",
      detail: "时间顺序、单日强度与预算都在常规范围内，出发前再核对预约与天气即可。",
      day: null,
    });
  }

  const order: Record<IssueLevel, number> = { risk: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}
