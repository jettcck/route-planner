import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  CloudSun,
  Download,
  ExternalLink,
  HelpCircle,
  KeyRound,
  MapPin,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import {
  tripSchema,
  type Activity,
  type PlannerInput,
  type Trip,
} from "./types";
import { createSampleTrip, defaultInput } from "./sample";
import { getWeather, type Weather } from "./weather";
import "./App.css";

const preferences = ["美食", "人文", "自然", "亲子", "摄影", "购物"];
type DestinationOption = {
  name: string;
  type: "城市" | "景点";
  region: string;
};
const destinationOptions: DestinationOption[] = [
  { name: "北京", type: "城市", region: "北京市" },
  { name: "上海", type: "城市", region: "上海市" },
  { name: "广州", type: "城市", region: "广东省" },
  { name: "深圳", type: "城市", region: "广东省" },
  { name: "珠海", type: "城市", region: "广东省" },
  { name: "成都", type: "城市", region: "四川省" },
  { name: "重庆", type: "城市", region: "重庆市" },
  { name: "西安", type: "城市", region: "陕西省" },
  { name: "杭州", type: "城市", region: "浙江省" },
  { name: "南京", type: "城市", region: "江苏省" },
  { name: "苏州", type: "城市", region: "江苏省" },
  { name: "厦门", type: "城市", region: "福建省" },
  { name: "福州", type: "城市", region: "福建省" },
  { name: "青岛", type: "城市", region: "山东省" },
  { name: "大连", type: "城市", region: "辽宁省" },
  { name: "三亚", type: "城市", region: "海南省" },
  { name: "海口", type: "城市", region: "海南省" },
  { name: "北海", type: "城市", region: "广西壮族自治区" },
  { name: "桂林", type: "城市", region: "广西壮族自治区" },
  { name: "昆明", type: "城市", region: "云南省" },
  { name: "大理", type: "城市", region: "云南省" },
  { name: "丽江", type: "城市", region: "云南省" },
  { name: "拉萨", type: "城市", region: "西藏自治区" },
  { name: "张家界", type: "城市", region: "湖南省" },
  { name: "故宫博物院", type: "景点", region: "北京" },
  { name: "八达岭长城", type: "景点", region: "北京" },
  { name: "颐和园", type: "景点", region: "北京" },
  { name: "天坛公园", type: "景点", region: "北京" },
  { name: "外滩", type: "景点", region: "上海" },
  { name: "上海迪士尼度假区", type: "景点", region: "上海" },
  { name: "西湖", type: "景点", region: "杭州" },
  { name: "乌镇", type: "景点", region: "浙江嘉兴" },
  { name: "鼓浪屿", type: "景点", region: "厦门" },
  { name: "黄山风景区", type: "景点", region: "安徽黄山" },
  { name: "九寨沟", type: "景点", region: "四川阿坝" },
  { name: "稻城亚丁", type: "景点", region: "四川甘孜" },
  { name: "张家界国家森林公园", type: "景点", region: "湖南张家界" },
  { name: "桂林漓江", type: "景点", region: "广西桂林" },
  { name: "秦始皇帝陵博物院", type: "景点", region: "陕西西安" },
  { name: "布达拉宫", type: "景点", region: "西藏拉萨" },
  { name: "洱海", type: "景点", region: "云南大理" },
  { name: "玉龙雪山", type: "景点", region: "云南丽江" },
  { name: "天涯海角", type: "景点", region: "海南三亚" },
  { name: "长白山", type: "景点", region: "吉林" },
  { name: "黄果树瀑布", type: "景点", region: "贵州安顺" },
  { name: "梵净山", type: "景点", region: "贵州铜仁" },
  { name: "泰山", type: "景点", region: "山东泰安" },
  { name: "莫高窟", type: "景点", region: "甘肃敦煌" },
  { name: "平遥古城", type: "景点", region: "山西晋中" },
  { name: "宏村", type: "景点", region: "安徽黄山" },
];
type ProviderId = "openai" | "deepseek" | "zhipu" | "qwen" | "moonshot" | "siliconflow" | "custom";
type Provider = {
  id: ProviderId;
  name: string;
  endpoint: string;
  model: string;
  keyUrl?: string;
  note: string;
};
const providers: Provider[] = [
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", keyUrl: "https://platform.openai.com/api-keys", note: "国际服务，模型选择较多" },
  { id: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", note: "中文使用体验好，价格亲民" },
  { id: "zhipu", name: "智谱 AI", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", note: "国内服务，支持 GLM 系列模型" },
  { id: "qwen", name: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-turbo", keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key", note: "阿里云百炼兼容接口" },
  { id: "moonshot", name: "Moonshot / Kimi", endpoint: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k", keyUrl: "https://platform.moonshot.cn/console/api-keys", note: "长文本和中文场景" },
  { id: "siliconflow", name: "SiliconFlow", endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen3-8B", keyUrl: "https://cloud.siliconflow.cn/account/ak", note: "可选择多种开源模型" },
  { id: "custom", name: "自定义兼容服务", endpoint: "https://", model: "", note: "填写服务方提供的接口地址和模型" },
];
const defaultProvider = providers[0];
function stored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function money(value: number) {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}
function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}
async function showMap(destination: string, location: string) {
  const url = `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${destination} ${location}`)}`;
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
async function openExternal(url: string) {
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function App() {
  const [input, setInput] = useState<PlannerInput>(() =>
    stored("route-input", defaultInput),
  );
  const [trip, setTrip] = useState<Trip>(() => {
    const parsed = tripSchema.safeParse(stored<unknown>("route-trip", null));
    return parsed.success ? parsed.data : createSampleTrip();
  });
  const [activeDay, setActiveDay] = useState(0);
  const [apiKeys, setApiKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [providerId, setProviderId] = useState<ProviderId>("openai");
  const [endpoint, setEndpoint] = useState(defaultProvider.endpoint);
  const [model, setModel] = useState(defaultProvider.model);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [tutorialStep, setTutorialStep] = useState<number | null>(() =>
    stored("route-tutorial-seen", false) ? null : 0,
  );
  const [editing, setEditing] = useState<{
    day: number;
    index: number;
    activity: Activity;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [weather, setWeather] = useState<Weather[]>([]);
  const [weatherStatus, setWeatherStatus] = useState("");
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [highlightedDestination, setHighlightedDestination] = useState(0);
  const day = trip.days[Math.min(activeDay, trip.days.length - 1)];
  const dates = trip.days.map((item) => item.date).join(",");
  const total = useMemo(
    () =>
      trip.days.reduce(
        (sum, item) =>
          sum +
          item.activities.reduce(
            (part, activity) => part + activity.estimatedCost,
            0,
          ),
        0,
      ),
    [trip],
  );

  useEffect(() => {
    localStorage.setItem("route-input", JSON.stringify(input));
  }, [input]);
  useEffect(() => {
    localStorage.setItem("route-trip", JSON.stringify(trip));
  }, [trip]);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    check()
      .then((update) => {
        if (!cancelled && update) setAvailableUpdate(update);
        else update?.close();
      })
      .catch(() => {
        // Update checks are best effort and should not interrupt planning.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setWeather([]);
    setWeatherStatus("查询中");
    getWeather(trip.destination, dates.split(","))
      .then((result) => {
        if (!cancelled) {
          setWeather(result.days);
          setWeatherStatus(result.message);
        }
      })
      .catch(() => {
        if (!cancelled) setWeatherStatus("天气暂不可用");
      });
    return () => {
      cancelled = true;
    };
  }, [trip.destination, dates]);

  function change<K extends keyof PlannerInput>(
    key: K,
    value: PlannerInput[K],
  ) {
    setInput((previous) => ({ ...previous, [key]: value }));
  }
  function closeTutorial(openSettings = false) {
    localStorage.setItem("route-tutorial-seen", "true");
    setTutorialStep(null);
    if (openSettings) setSettingsOpen(true);
  }
  function showTutorial() {
    setSettingsOpen(false);
    setTutorialStep(0);
  }
  const provider = providers.find((item) => item.id === providerId) ?? defaultProvider;
  const apiKey = apiKeys[providerId] ?? "";
  function selectProvider(nextId: ProviderId) {
    const next = providers.find((item) => item.id === nextId) ?? defaultProvider;
    setProviderId(nextId);
    setEndpoint(next.endpoint);
    setModel(next.model);
  }
  async function installUpdate() {
    if (!availableUpdate) return;
    setUpdateBusy(true);
    setUpdateError("");
    try {
      await availableUpdate.downloadAndInstall();
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
      setUpdateBusy(false);
    }
  }
  async function generate() {
    setError("");
    if (!input.destination.trim()) {
      setError("请先填写目的地");
      return;
    }
    if (!apiKey.trim()) {
      setSettingsOpen(true);
      setError("请在 AI 设置中填写 API Key");
      return;
    }
    if (!isTauri()) {
      setError("AI 生成功能请在 Tauri 桌面版中使用");
      return;
    }
    setBusy(true);
    try {
      const raw = await invoke<string>("generate_trip", {
        apiKey: apiKey.trim(),
        endpoint: endpoint.trim(),
        model: model.trim(),
        request: input,
      });
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const result = tripSchema.parse(JSON.parse(cleaned));
      if (result.days.length !== input.days)
        throw new Error("AI 返回的行程天数与设置不符，请重试");
      setTrip({ ...result, sample: false });
      setActiveDay(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  function updateActivity(dayIndex: number, index: number, activity: Activity) {
    setTrip((previous) => ({
      ...previous,
      days: previous.days.map((item, d) =>
        d === dayIndex
          ? {
              ...item,
              activities:
                index < 0
                  ? [...item.activities, activity]
                  : item.activities.map((entry, i) =>
                      i === index ? activity : entry,
                    ),
            }
          : item,
      ),
    }));
    setEditing(null);
  }
  function removeActivity(dayIndex: number, index: number) {
    setTrip((previous) => ({
      ...previous,
      days: previous.days.map((item, d) =>
        d === dayIndex
          ? {
              ...item,
              activities: item.activities.filter((_, i) => i !== index),
            }
          : item,
      ),
    }));
    setEditing(null);
  }
  function moveActivity(dayIndex: number, index: number, offset: number) {
    setTrip((previous) => ({
      ...previous,
      days: previous.days.map((item, d) => {
        if (d !== dayIndex) return item;
        const activities = [...item.activities];
        const target = index + offset;
        if (target < 0 || target >= activities.length) return item;
        [activities[index], activities[target]] = [
          activities[target],
          activities[index],
        ];
        return { ...item, activities };
      }),
    }));
  }
  function exportJson() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(trip, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${trip.destination || "旅行"}-行程.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const dayWeather = weather.find((item) => item.date === day?.date);
  const destinationSuggestions = useMemo(() => {
    const query = input.destination.trim();
    if (!query) return [];
    return destinationOptions
      .filter(
        (option) => option.name.includes(query) || option.region.includes(query),
      )
      .sort((a, b) => {
        const aStarts = a.name.startsWith(query) ? 0 : 1;
        const bStarts = b.name.startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name, "zh-CN");
      })
      .slice(0, 8);
  }, [input.destination]);

  function selectDestination(option: DestinationOption) {
    change("destination", option.name);
    setDestinationFocused(false);
    setHighlightedDestination(0);
  }

  function handleDestinationKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
  ) {
    if (!destinationSuggestions.length) {
      if (event.key === "Escape") setDestinationFocused(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedDestination((current) =>
        Math.min(current + 1, destinationSuggestions.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedDestination((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectDestination(destinationSuggestions[highlightedDestination]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDestinationFocused(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <MapPin size={20} strokeWidth={2.5} />
          </span>
          <span>
            途迹<span className="brand-en"> / ROUTE</span>
          </span>
        </div>
        <div className="sidebar-label">工作空间</div>
        <div className="nav-item active">
          <CalendarDays size={18} />
          行程规划
        </div>
        <div className="sidebar-spacer" />
        <button className="nav-item nav-button" onClick={showTutorial}>
          <HelpCircle size={18} />
          新手教程
        </button>
        <div className="sidebar-note">
          <span className="status-dot" />
          行程仅保存在此设备
        </div>
        <button
          className="nav-item nav-button"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={18} />
          AI 设置
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            行程规划 <span>/</span> <strong>{trip.destination}</strong>
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              title="打开新手教程"
              aria-label="打开新手教程"
              onClick={showTutorial}
            >
              <HelpCircle size={18} />
            </button>
            <button
              className="icon-button"
              title="下载行程 JSON"
              aria-label="下载行程 JSON"
              onClick={exportJson}
            >
              <Download size={18} />
            </button>
            <button
              className="icon-button"
              title="打印或保存为 PDF"
              aria-label="打印或保存为 PDF"
              onClick={() => window.print()}
            >
              <Printer size={18} />
            </button>
            <button
              className="text-button"
              onClick={() => setSettingsOpen(true)}
            >
              <KeyRound size={16} />
              AI 设置
            </button>
          </div>
        </header>
        {availableUpdate && (
          <div className="update-banner" role="status">
            <div>
              <strong>发现新版本 v{availableUpdate.version}</strong>
              <span>更新会保留你的行程和设置，安装完成后应用将自动重启。</span>
              {updateError && <small>{updateError}</small>}
            </div>
            <button onClick={installUpdate} disabled={updateBusy}>
              {updateBusy ? "正在更新..." : "立即更新"}
            </button>
          </div>
        )}
        <div className="workspace-body">
          <section className="planner-panel" aria-label="规划条件">
            <div className="panel-kicker">NEW JOURNEY</div>
            <h1>规划下一程</h1>
            <p className="panel-subtitle">告诉我你的出行安排</p>
            <div className="form-stack">
              <label className="field">
                <span>目的地</span>
                <div className="destination-autocomplete">
                  <div className="input-icon">
                    <MapPin size={17} />
                    <input
                      value={input.destination}
                      placeholder="例如：北京或故宫"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={destinationFocused && destinationSuggestions.length > 0}
                      aria-controls="destination-suggestions"
                      onFocus={() => setDestinationFocused(true)}
                      onBlur={() => setTimeout(() => setDestinationFocused(false), 120)}
                      onKeyDown={handleDestinationKeyDown}
                      onChange={(event) => {
                        setHighlightedDestination(0);
                        change("destination", event.target.value);
                      }}
                    />
                  </div>
                  {destinationFocused && destinationSuggestions.length > 0 && (
                    <div
                      id="destination-suggestions"
                      className="destination-suggestions"
                      role="listbox"
                    >
                      {destinationSuggestions.map((option, index) => (
                        <button
                          type="button"
                          key={`${option.type}-${option.name}`}
                          className={`destination-option${
                            index === highlightedDestination ? " active" : ""
                          }`}
                          role="option"
                          aria-selected={index === highlightedDestination}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectDestination(option)}
                        >
                          <span className="destination-option-name">{option.name}</span>
                          <span className="destination-option-meta">
                            <span className={`destination-type ${option.type === "景点" ? "spot" : "city"}`}>
                              {option.type}
                            </span>
                            {option.region}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label className="field">
                <span>出发日期</span>
                <div className="input-icon">
                  <CalendarDays size={17} />
                  <input
                    type="date"
                    value={input.startDate}
                    onChange={(event) =>
                      change("startDate", event.target.value)
                    }
                  />
                </div>
              </label>
              <div className="field-row">
                <div className="field">
                  <span>旅行天数</span>
                  <div className="stepper">
                    <button
                      title="减少一天"
                      aria-label="减少一天"
                      onClick={() =>
                        change("days", Math.max(1, input.days - 1))
                      }
                    >
                      <Minus size={15} />
                    </button>
                    <strong>{input.days} 天</strong>
                    <button
                      title="增加一天"
                      aria-label="增加一天"
                      onClick={() =>
                        change("days", Math.min(14, input.days + 1))
                      }
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                <div className="field">
                  <span>出行人数</span>
                  <div className="stepper">
                    <button
                      title="减少一人"
                      aria-label="减少一人"
                      onClick={() =>
                        change("travelers", Math.max(1, input.travelers - 1))
                      }
                    >
                      <Minus size={15} />
                    </button>
                    <strong>{input.travelers} 人</strong>
                    <button
                      title="增加一人"
                      aria-label="增加一人"
                      onClick={() =>
                        change("travelers", Math.min(20, input.travelers + 1))
                      }
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
              </div>
              <label className="field">
                <span>
                  总预算 <small>人民币</small>
                </span>
                <div className="input-prefix">
                  <b>¥</b>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={input.budget}
                    onChange={(event) =>
                      change("budget", Math.max(0, Number(event.target.value)))
                    }
                  />
                </div>
              </label>
              <div className="field">
                <span>旅行节奏</span>
                <div className="segmented">
                  {(["轻松", "适中", "充实"] as const).map((value) => (
                    <button
                      key={value}
                      className={input.pace === value ? "selected" : ""}
                      onClick={() => change("pace", value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span>偏好</span>
                <div className="chips">
                  {preferences.map((value) => (
                    <button
                      key={value}
                      className={
                        input.interests.includes(value) ? "selected" : ""
                      }
                      onClick={() =>
                        change(
                          "interests",
                          input.interests.includes(value)
                            ? input.interests.filter((item) => item !== value)
                            : [...input.interests, value],
                        )
                      }
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span>补充要求</span>
                <textarea
                  rows={3}
                  value={input.notes}
                  placeholder="例如：带老人同行、避开热门景点"
                  onChange={(event) => change("notes", event.target.value)}
                />
              </label>
            </div>
            <button
              className="generate-button"
              onClick={generate}
              disabled={busy}
            >
              <Sparkles size={18} />
              {busy ? "正在生成攻略..." : "一键生成攻略"}
            </button>
            <button
              className="sample-button"
              onClick={() => {
                setTrip(createSampleTrip());
                setActiveDay(0);
                setError("");
              }}
            >
              查看示例行程
            </button>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
          </section>
          <main className="trip-panel">
            <div className="trip-heading">
              <div>
                <div className="eyebrow">
                  YOUR ITINERARY{" "}
                  {trip.sample && <span className="sample-badge">示例</span>}
                </div>
                <h2>{trip.title}</h2>
                <p>{trip.overview}</p>
              </div>
              <button
                className="refresh-button"
                title="重新生成行程"
                onClick={generate}
                disabled={busy}
              >
                <RefreshCw size={17} />
                <span>重新生成</span>
              </button>
            </div>
            <div className="summary-strip">
              <div>
                <CalendarDays size={18} />
                <span>
                  <b>{trip.days.length} 天</b>
                  <small>{shortDate(trip.days[0]?.date || "")} 出发</small>
                </span>
              </div>
              <div>
                <Wallet size={18} />
                <span>
                  <b>{money(total)}</b>
                  <small>活动费用估算</small>
                </span>
              </div>
              <div>
                <CloudSun size={18} />
                <span>
                  <b>{dayWeather?.label || "天气"}</b>
                  <small>{weatherStatus || "预报查询中"}</small>
                </span>
              </div>
            </div>
            <div className="day-tabs" role="tablist" aria-label="旅行日期">
              {trip.days.map((item, index) => (
                <button
                  key={`${item.date}-${index}`}
                  role="tab"
                  aria-selected={activeDay === index}
                  className={activeDay === index ? "active" : ""}
                  onClick={() => setActiveDay(index)}
                >
                  <b>DAY {String(index + 1).padStart(2, "0")}</b>
                  <span>{shortDate(item.date)}</span>
                </button>
              ))}
            </div>
            {day && (
              <div className="day-content">
                <div className="day-title-row">
                  <div>
                    <div className="eyebrow">
                      DAY {String(activeDay + 1).padStart(2, "0")}
                    </div>
                    <h3>{day.theme}</h3>
                  </div>
                  <div className="day-total">
                    当日估算{" "}
                    <strong>
                      {money(
                        day.activities.reduce(
                          (sum, item) => sum + item.estimatedCost,
                          0,
                        ),
                      )}
                    </strong>
                  </div>
                </div>
                {dayWeather && (
                  <div className="weather-line">
                    <CloudSun size={17} />
                    {dayWeather.summary}
                    <span>Open-Meteo 预报</span>
                  </div>
                )}
                <div className="timeline">
                  {day.activities.map((item, index) => (
                    <article className="activity" key={`${activeDay}-${index}`}>
                      <div className="timeline-time">{item.time}</div>
                      <div className="timeline-dot" />
                      <div className="activity-content">
                        <div className="activity-heading">
                          <div>
                            <span className="activity-kind">{item.type}</span>
                            <h4>{item.title}</h4>
                          </div>
                          <span className="activity-cost">
                            {item.estimatedCost
                              ? money(item.estimatedCost)
                              : "免费"}
                          </span>
                        </div>
                        <p>{item.detail}</p>
                        <div className="activity-meta">
                          <span>
                            <MapPin size={14} />
                            {item.location}
                          </span>
                          <span>{item.durationMinutes} 分钟</span>
                          <button
                            onClick={() =>
                              showMap(trip.destination, item.location)
                            }
                          >
                            查看地图 <ExternalLink size={13} />
                          </button>
                        </div>
                        <div className="activity-tools">
                          <button
                            onClick={() =>
                              setEditing({
                                day: activeDay,
                                index,
                                activity: { ...item },
                              })
                            }
                          >
                            编辑
                          </button>
                          <button
                            title="上移"
                            aria-label="上移"
                            disabled={index === 0}
                            onClick={() => moveActivity(activeDay, index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            title="下移"
                            aria-label="下移"
                            disabled={index === day.activities.length - 1}
                            onClick={() => moveActivity(activeDay, index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            title="删除"
                            aria-label="删除"
                            onClick={() => removeActivity(activeDay, index)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                <button
                  className="add-activity"
                  onClick={() =>
                    setEditing({
                      day: activeDay,
                      index: -1,
                      activity: {
                        time: "12:00",
                        title: "",
                        detail: "",
                        location: "",
                        estimatedCost: 0,
                        durationMinutes: 60,
                        type: "自定义",
                      },
                    })
                  }
                >
                  <Plus size={17} />
                  添加安排
                </button>
              </div>
            )}
            <section className="tips-section">
              <h3>出行提示</h3>
              <div className="tips-list">
                {trip.tips.map((tip, index) => (
                  <p key={index}>
                    <Check size={16} />
                    {tip}
                  </p>
                ))}
              </div>
              <p className="estimate-note">
                行程中的费用和场所信息为规划参考，出发前请核对官方渠道。
              </p>
            </section>
            <section className="print-only print-itinerary">
              {trip.days.map((printDay, index) => (
                <div className="print-day" key={`${printDay.date}-${index}`}>
                  <h3>
                    第 {index + 1} 天 · {shortDate(printDay.date)} ·{" "}
                    {printDay.theme}
                  </h3>
                  {printDay.activities.map((item, itemIndex) => (
                    <div className="print-activity" key={itemIndex}>
                      <strong>
                        {item.time}　{item.title}
                      </strong>
                      <span>
                        {item.location} · {item.durationMinutes} 分钟 ·{" "}
                        {money(item.estimatedCost)}
                      </span>
                      <p>{item.detail}</p>
                    </div>
                  ))}
                </div>
              ))}
              <h3>出行提示</h3>
              {trip.tips.map((tip, index) => (
                <p key={index}>· {tip}</p>
              ))}
            </section>
          </main>
        </div>
      </div>
      {tutorialStep !== null && (
        <div className="modal-backdrop">
          <section
            className="modal tutorial-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tutorial-title"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">快速上手 · {tutorialStep + 1} / 3</div>
                <h2 id="tutorial-title">
                  {[
                    "获取 API Key",
                    "在应用里完成设置",
                    "生成并使用攻略",
                  ][tutorialStep]}
                </h2>
              </div>
              <button
                className="icon-button"
                title="跳过教程"
                aria-label="跳过教程"
                onClick={() => closeTutorial()}
              >
                <X size={19} />
              </button>
            </div>
            <div className="tutorial-progress" aria-label={`第 ${tutorialStep + 1} 步，共 3 步`}>
              {[0, 1, 2].map((step) => (
                <span key={step} className={step <= tutorialStep ? "active" : ""} />
              ))}
            </div>
            {tutorialStep === 0 && (
              <div className="tutorial-content">
                <p>AI 生成攻略需要你选择一家服务商并准备对应的 API Key。支持 OpenAI、DeepSeek、智谱 AI、通义千问、Moonshot/Kimi 和 SiliconFlow。</p>
                <button className="tutorial-link" onClick={() => openExternal(provider.keyUrl ?? "https://platform.openai.com/api-keys")}>
                  打开 {provider.name} 的 API Key 页面 <ExternalLink size={15} />
                </button>
                <p className="tutorial-note">API 使用可能需要单独开通付费或充值；ChatGPT 订阅通常不包含 API 额度。请勿把密钥发给其他人。</p>
              </div>
            )}
            {tutorialStep === 1 && (
              <div className="tutorial-content">
                <p>点击应用中的“AI 设置”，把刚复制的密钥粘贴到“API Key”输入框，然后点击“完成”。</p>
                <p>在“AI 设置”中选择服务商，模型和接口地址会自动填好。使用自定义服务时，再按服务方说明填写这两项。</p>
                <p className="tutorial-note">密钥只在当前窗口中使用；关闭应用后需要重新填写。</p>
              </div>
            )}
            {tutorialStep === 2 && (
              <div className="tutorial-content">
                <p>填写目的地、日期、天数、人数和预算，再选择旅行节奏与偏好，点击“一键生成攻略”。</p>
                <p>生成后可以切换日期、编辑或调整活动顺序，也可以打印、保存为 PDF 或下载 JSON。出行前请核对开放时间、费用和天气。</p>
              </div>
            )}
            <div className="tutorial-actions">
              <button className="tutorial-skip" onClick={() => closeTutorial()}>
                跳过
              </button>
              {tutorialStep > 0 && (
                <button className="tutorial-back" onClick={() => setTutorialStep(tutorialStep - 1)}>
                  上一步
                </button>
              )}
              <button
                className="tutorial-next"
                onClick={() =>
                  tutorialStep === 2
                    ? closeTutorial(true)
                    : setTutorialStep(tutorialStep + 1)
                }
              >
                {tutorialStep === 2 ? "打开 AI 设置" : "下一步"}
              </button>
            </div>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="AI 设置"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">CONFIGURATION</div>
                <h2>AI 设置</h2>
              </div>
              <button
                className="icon-button"
                title="关闭"
                aria-label="关闭"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <p className="modal-intro">
              使用兼容 Chat Completions 的服务生成行程。API Key 只在当前窗口中使用，关闭应用后清除。
            </p>
            <div className="settings-help">
              <strong>第一次使用？</strong>
              <span>选择服务商后，打开对应页面创建 API Key，复制后粘贴到下方。各服务的计费和额度独立。</span>
              <div>
                <button onClick={() => openExternal(provider.keyUrl ?? "https://platform.openai.com/api-keys")}>
                  获取 API Key <ExternalLink size={14} />
                </button>
                <button onClick={showTutorial}>查看完整教程</button>
              </div>
            </div>
            <label className="field">
              <span>AI 服务商</span>
              <select value={providerId} onChange={(event) => selectProvider(event.target.value as ProviderId)}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <small className="provider-note">{provider.note}</small>
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder="在这里粘贴你的 API Key"
                onChange={(event) =>
                  setApiKeys((previous) => ({
                    ...previous,
                    [providerId]: event.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label className="field">
              <span>接口地址</span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </label>
            <p className="settings-hint">预置服务商会自动填写接口地址和常用模型；自定义服务请使用 HTTPS 的 Chat Completions 兼容地址。</p>
            <button
              className="modal-primary"
              onClick={() => setSettingsOpen(false)}
            >
              完成
            </button>
          </section>
        </div>
      )}
      {editing && (
        <ActivityEditor
          data={editing.activity}
          onClose={() => setEditing(null)}
          onSave={(activity) =>
            updateActivity(editing.day, editing.index, activity)
          }
        />
      )}
      <div className="print-only print-footer">
        费用与营业信息请以官方渠道为准 · 途迹行程规划
      </div>
    </div>
  );
}

function ActivityEditor({
  data,
  onClose,
  onSave,
}: {
  data: Activity;
  onClose: () => void;
  onSave: (activity: Activity) => void;
}) {
  const [value, setValue] = useState(data);
  function change<K extends keyof Activity>(key: K, next: Activity[K]) {
    setValue((previous) => ({ ...previous, [key]: next }));
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="编辑安排"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.title.trim()) onSave(value);
        }}
      >
        <div className="modal-header">
          <h2>行程安排</h2>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        <div className="field-row">
          <label className="field">
            <span>时间</span>
            <input
              type="time"
              value={value.time}
              onChange={(event) => change("time", event.target.value)}
            />
          </label>
          <label className="field">
            <span>类别</span>
            <input
              value={value.type}
              onChange={(event) => change("type", event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>安排名称</span>
          <input
            required
            value={value.title}
            onChange={(event) => change("title", event.target.value)}
          />
        </label>
        <label className="field">
          <span>地点</span>
          <input
            value={value.location}
            onChange={(event) => change("location", event.target.value)}
          />
        </label>
        <label className="field">
          <span>说明</span>
          <textarea
            rows={3}
            value={value.detail}
            onChange={(event) => change("detail", event.target.value)}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>预计费用（元）</span>
            <input
              type="number"
              min="0"
              value={value.estimatedCost}
              onChange={(event) =>
                change("estimatedCost", Math.max(0, Number(event.target.value)))
              }
            />
          </label>
          <label className="field">
            <span>时长（分钟）</span>
            <input
              type="number"
              min="1"
              value={value.durationMinutes}
              onChange={(event) =>
                change(
                  "durationMinutes",
                  Math.max(1, Number(event.target.value)),
                )
              }
            />
          </label>
        </div>
        <button className="modal-primary" type="submit">
          保存安排
        </button>
      </form>
    </div>
  );
}

export default App;
