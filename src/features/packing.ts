import type { PlannerInput, Trip } from "../types";
import type { Weather } from "../weather";
import { uid } from "./store";

export const packingCategories = [
  "证件",
  "电子",
  "衣物",
  "洗护",
  "药品",
  "户外",
  "其他",
] as const;
export type PackingCategory = (typeof packingCategories)[number];

export type PackingItem = {
  id: string;
  label: string;
  category: PackingCategory;
  checked: boolean;
  /** 用户手动添加的条目，重新生成时不会被清掉。 */
  custom?: boolean;
  /** 生成来源，用于在界面上解释「为什么带这个」。 */
  reason?: string;
};

const packingCategorySet = new Set<PackingCategory>(packingCategories);
export const MAX_PACKING_ITEMS = 1_000;

/** 清洗本地清单，避免损坏条目导致复选框或分组渲染异常。 */
export function sanitizePackingItems(value: unknown): PackingItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: PackingItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.slice(0, MAX_PACKING_ITEMS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Partial<PackingItem>;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 120 || ids.has(item.id)) continue;
    if (typeof item.label !== "string" || item.label.trim().length === 0 || item.label.length > 160) continue;
    if (typeof item.category !== "string" || !packingCategorySet.has(item.category as PackingCategory)) continue;
    if (typeof item.checked !== "boolean") continue;
    if (item.custom !== undefined && typeof item.custom !== "boolean") continue;
    if (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 500)) continue;
    ids.add(item.id);
    result.push({
      id: item.id,
      label: item.label.trim(),
      category: item.category as PackingCategory,
      checked: item.checked,
      custom: item.custom === true ? true : undefined,
      reason: item.reason,
    });
  }
  return result;
}

type Seed = { label: string; category: PackingCategory; reason?: string };

function push(list: Seed[], label: string, category: PackingCategory, reason?: string) {
  if (!list.some((item) => item.label === label)) {
    list.push({ label, category, reason });
  }
}

/** 全量扫描行程文本，判断这趟旅行会用到哪些装备。 */
function scanSignals(trip: Trip, weather: Weather[]) {
  const activityText = trip.days
    .flatMap((day) => day.activities)
    .map((item) => `${item.type}${item.title}${item.location}${item.detail}`)
    .join(" ");
  const text = `${trip.destination} ${trip.title} ${trip.overview} ${trip.tips.join(" ")} ${activityText}`;
  const labels = weather.map((item) => item.label).join(" ");
  const mins = weather.map((item) => item.min).filter((value): value is number => typeof value === "number");
  const maxs = weather.map((item) => item.max).filter((value): value is number => typeof value === "number");
  const rains = weather.map((item) => item.rain).filter((value): value is number => typeof value === "number");
  return {
    text,
    activityText,
    rainy: /雨|雷/.test(labels) || rains.some((value) => value >= 50),
    snowy: /雪/.test(labels) || (mins.length > 0 && Math.min(...mins) <= 0),
    cold: mins.length > 0 && Math.min(...mins) <= 8,
    hot: maxs.length > 0 && Math.max(...maxs) >= 30,
    outdoor: /登山|徒步|山|峡谷|森林|草原|湖|沙漠|露营|徒步|骑行/.test(text),
    beach: /海岛|海边|沙滩|浮潜|潜水|岛|海岸/.test(text),
    ski: /滑雪|雪场|冰雪/.test(text),
    hotSpring: /温泉|汤池|泡汤/.test(text),
    altitude: /拉萨|西藏|高原|稻城|香格里拉|青海|纳木错|可可西里|珠峰|理塘|若尔盖/.test(text),
    night: /夜景|夜游|星空|日出|日落|夜市/.test(text),
    shopping: /购物|奥特莱斯|免税|商场|市集/.test(text),
    kid: /亲子|儿童|乐园|长隆|迪士尼|海洋公园|动物园/.test(text),
  };
}

/**
 * 依据目的地、天数、天气与活动类型生成建议行李清单。
 * 规则是可解释的：每条建议都能追到具体依据。
 */
export function generatePackingList(
  trip: Trip,
  input: PlannerInput,
  weather: Weather[],
): PackingItem[] {
  const signal = scanSignals(trip, weather);
  const days = Math.max(1, trip.days.length);
  const seeds: Seed[] = [];

  // 证件与凭证
  push(seeds, "身份证", "证件", "国内出行必备");
  push(seeds, "住宿预订凭证", "证件", `共 ${days} 天行程`);
  push(seeds, "门票/预约确认信息", "证件", "多数景区需提前实名预约");
  push(seeds, "驾驶证（如需租车）", "证件");
  push(seeds, "行程单打印件", "证件", "离线也能查看，避免断网抓瞎");
  push(seeds, "现金与银行卡", "证件", "偏远地区或小店可能不支持扫码");

  // 电子
  push(seeds, "手机与充电器", "电子");
  push(seeds, "充电宝", "电子", "全天在外拍照导航耗电快");
  push(seeds, "数据线（备用一根）", "电子");
  push(seeds, "耳机", "电子");
  if (input.interests.includes("摄影") || signal.night) {
    push(seeds, "相机与备用电池", "电子", "行程含摄影/夜景安排");
    push(seeds, "存储卡", "电子", "行程含摄影/夜景安排");
    push(seeds, "小型三脚架", "电子", "夜景与合影稳定出片");
  }
  if (days >= 5) push(seeds, "多口充电头", "电子", "长途旅行设备多");

  // 衣物
  push(seeds, "换洗衣物", "衣物", `${days} 天行程，按天准备`);
  push(seeds, "内衣与袜子", "衣物", `${days} 天行程`);
  push(seeds, "睡衣", "衣物");
  push(seeds, "舒适步行鞋", "衣物", "行程以步行为主");
  if (signal.cold) {
    push(seeds, "保暖内层", "衣物", "预报有低温");
    push(seeds, "厚外套/羽绒服", "衣物", "预报有低温");
    push(seeds, "手套与围巾", "衣物", "预报有低温");
    push(seeds, "保暖帽", "衣物", "预报有低温");
  }
  if (signal.hot) {
    push(seeds, "速干短袖", "衣物", "预报有高温");
    push(seeds, "遮阳帽", "衣物", "预报有高温");
    push(seeds, "墨镜", "衣物", "预报有高温");
  }
  if (signal.rainy) push(seeds, "速干外套", "衣物", "预报有降水");

  // 洗护
  push(seeds, "牙刷牙膏", "洗护");
  push(seeds, "洗发沐浴旅行装", "洗护");
  push(seeds, "护肤品", "洗护");
  if (signal.hot || signal.beach || signal.altitude) {
    push(seeds, "防晒霜（高倍）", "洗护", "紫外线较强");
    push(seeds, "晒后修复", "洗护", "紫外线较强");
  }
  push(seeds, "纸巾与湿巾", "洗护");
  push(seeds, "免洗洗手液", "洗护");

  // 药品
  push(seeds, "创可贴", "药品", "步行量大，防磨脚");
  push(seeds, "感冒药", "药品");
  push(seeds, "肠胃药", "药品", "尝试当地饮食");
  push(seeds, "个人常用药", "药品");
  if (signal.altitude) {
    push(seeds, "高原反应用药", "药品", "行程涉及高原");
    push(seeds, "便携氧气罐", "药品", "行程涉及高原");
  }
  if (signal.rainy) push(seeds, "晕车药", "药品", "雨天山路/长途车程");

  // 户外与场景
  if (signal.outdoor) {
    push(seeds, "防滑徒步鞋", "户外", "行程含登山/徒步");
    push(seeds, "登山杖或护膝", "户外", "行程含登山/徒步");
    push(seeds, "头灯或手电", "户外", "户外行程备用照明");
    push(seeds, "便携水壶", "户外");
    push(seeds, "驱蚊液", "户外");
  }
  if (signal.beach) {
    push(seeds, "泳衣", "户外", "行程含海岛/沙滩");
    push(seeds, "沙滩拖鞋", "户外", "行程含海岛/沙滩");
    push(seeds, "防水手机袋", "户外", "行程含海岛/沙滩");
  }
  if (signal.hotSpring) push(seeds, "泳衣与速干毛巾", "户外", "行程含温泉");
  if (signal.ski) {
    push(seeds, "雪镜与滑雪手套", "户外", "行程含滑雪");
    push(seeds, "保暖护脸头套", "户外", "行程含滑雪");
  }
  if (signal.rainy) {
    push(seeds, "折叠雨伞", "户外", "预报有降水");
    push(seeds, "一次性雨衣", "户外", "预报有降水");
    push(seeds, "背包防雨罩", "户外", "预报有降水");
  }
  if (signal.shopping) push(seeds, "折叠行李袋", "其他", "行程含购物安排");
  if (signal.kid) {
    push(seeds, "儿童常用药与退烧贴", "其他", "行程含亲子安排");
    push(seeds, "儿童水杯与零食", "其他", "行程含亲子安排");
    push(seeds, "推车或背带", "其他", "行程含亲子安排");
  }
  push(seeds, "移动电源线转接头", "其他");

  return seeds.map((seed) => ({
    id: uid("pack"),
    label: seed.label,
    category: seed.category,
    checked: false,
    reason: seed.reason,
  }));
}

/** 重新生成时保留勾选状态与自定义条目，只补充新命中的建议。 */
export function mergePackingList(
  existing: PackingItem[],
  generated: PackingItem[],
): PackingItem[] {
  const byLabel = new Map(existing.map((item) => [item.label, item]));
  const merged = generated.map((item) => {
    const previous = byLabel.get(item.label);
    return previous
      ? { ...item, id: previous.id, checked: previous.checked }
      : item;
  });
  const kept = existing.filter((item) => item.custom);
  return [...merged, ...kept].slice(0, MAX_PACKING_ITEMS);
}

export function packingProgress(items: PackingItem[]) {
  const total = items.length;
  const done = items.filter((item) => item.checked).length;
  return {
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}
