import type { PlannerInput, Trip } from "./types";

const departure = new Date();
departure.setDate(departure.getDate() + 7);
const dateAt = (offset: number) => {
  const date = new Date(departure);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export const defaultInput: PlannerInput = {
  destination: "北京",
  startDate: dateAt(0),
  days: 3,
  travelers: 2,
  budget: 5000,
  pace: "适中",
  interests: ["人文", "美食"],
  notes: "",
};

export function createSampleTrip(): Trip {
  return {
    title: "北京 · 城市漫游三日",
    destination: "北京",
    sample: true,
    overview: "从中轴线到胡同街巷，留出时间步行、吃饭和感受城市。",
    days: [
      {
        date: dateAt(0),
        theme: "中轴线与老城",
        activities: [
          {
            time: "09:00",
            title: "天安门广场周边",
            detail:
              "沿中轴线步行，预留安检与交通时间。具体参观规则请提前核对官方公告。",
            location: "天安门广场",
            estimatedCost: 0,
            durationMinutes: 90,
            type: "城市漫步",
          },
          {
            time: "11:00",
            title: "故宫博物院",
            detail:
              "按预约时段入院，重点参观中轴线建筑与常设展。门票和开放安排以官方信息为准。",
            location: "故宫博物院",
            estimatedCost: 120,
            durationMinutes: 210,
            type: "人文",
          },
          {
            time: "17:00",
            title: "景山公园",
            detail:
              "登高看城市布局，是否适合日落观景取决于当天的天气和开放时间。",
            location: "景山公园",
            estimatedCost: 20,
            durationMinutes: 75,
            type: "观景",
          },
        ],
      },
      {
        date: dateAt(1),
        theme: "胡同与湖畔",
        activities: [
          {
            time: "09:30",
            title: "什刹海散步",
            detail: "沿湖步行，可按体力选择缩短路线。",
            location: "什刹海",
            estimatedCost: 0,
            durationMinutes: 90,
            type: "城市漫步",
          },
          {
            time: "12:00",
            title: "胡同午餐",
            detail: "选择附近餐馆用餐，避开高峰时段更从容。",
            location: "地安门",
            estimatedCost: 160,
            durationMinutes: 75,
            type: "美食",
          },
          {
            time: "14:00",
            title: "南锣鼓巷周边",
            detail: "以周边支巷为主，留意居民区通行秩序。",
            location: "南锣鼓巷",
            estimatedCost: 0,
            durationMinutes: 100,
            type: "街区",
          },
        ],
      },
      {
        date: dateAt(2),
        theme: "园林与返程",
        activities: [
          {
            time: "09:00",
            title: "颐和园",
            detail:
              "按体力选择昆明湖东岸或长廊路线，园区较大，建议穿舒适的鞋。",
            location: "颐和园",
            estimatedCost: 120,
            durationMinutes: 210,
            type: "园林",
          },
          {
            time: "14:00",
            title: "返程前自由时间",
            detail: "预留前往车站或机场的交通缓冲。",
            location: "北京市",
            estimatedCost: 100,
            durationMinutes: 90,
            type: "交通",
          },
        ],
      },
    ],
    tips: [
      "故宫等热门场所可能需要提前预约，出行前查看官方渠道。",
      "市区内尽量使用公共交通，跨城返程预留充足时间。",
      "上述费用为两人活动参考，不含住宿和往返大交通。",
    ],
  };
}
