import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  ArrowDown,
  ArrowUp,
  Backpack,
  CalendarDays,
  Check,
  CloudSun,
  Coins,
  Download,
  ExternalLink,
  Footprints,
  HelpCircle,
  KeyRound,
  Map,
  MapPin,
  Megaphone,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Wallet,
  WifiOff,
  X,
} from "lucide-react";
import {
  plannerInputSchema,
  MAX_ACTIVITIES_PER_DAY,
  tripSchema,
  type Activity,
  type PlannerInput,
  type Trip,
} from "./types";
import { createSampleTrip, defaultInput } from "./sample";
import { currentWeatherAdvice, getWeather, saveWeatherBackup, type CurrentWeather, type Weather } from "./weather";
import {
  CheckInView,
  HealthCard,
  LedgerView,
  PackingView,
  PrepView,
  ShareCard,
} from "./features/views";
import { auditTrip } from "./features/health";
import { sanitizePrepState, tripCountdown, weatherAdvisories } from "./features/reminders";
import { activityKey, activityHistoricalStableKey, activityLegacyStableKey, activityStableKey, readCheckIn, sanitizeCheckIns, type CheckInMap } from "./features/checkin";
import { currencies, expenseCategories, sanitizeExpenses, type Expense } from "./features/ledger";
import { MAX_PACKING_ITEMS, sanitizePackingItems, type PackingItem } from "./features/packing";
import {
  budgetFixNote,
  budgetPlanAdvice,
  budgetStatus,
  pickWithinBudget,
} from "./features/budget";
import {
  loadStored,
  saveJson,
  STORAGE_WRITE_FAILED_EVENT,
  tripNamespace,
  useStoredState,
} from "./features/store";
import { consumeSystemInteraction, downloadText } from "./features/share";
import {
  ALL_SECTIONS,
  BACKUP_FORMAT_ID,
  BACKUP_SCHEMA_VERSION,
  newSnapshotId,
  writeSnapshot,
} from "./features/backup";
import { BackupPanel } from "./features/backup-view";
import { LockScreen, LockSettings } from "./features/app-lock-view";
import { readLockConfig } from "./features/app-lock";
import "./features/backup.css";
import { AccountView } from "./features/auth-view";
import { authApi, useAuth } from "./features/auth";
import { useUiFeedback } from "./features/ui-feedback";
import { DEFAULT_VIEW, MULTI_PROVIDER_ENABLED, SINGLE_USER, accountEntryVisible, requiresAccount } from "./features/app-mode";
import { isAndroidSecureStore, readSecureEntry, writeSecure, deleteSecure } from "./features/secure-store";
import { createWeatherRegistration, type WeatherMonitorStatus } from "./features/weather-registration";
import { parseTripContent } from "./features/trip-generation";
import { buildTravelAgentSuggestions, sanitizeAgentReminders, validateAgentActionForTrip, validateAgentProposal, type AgentProposal, type TravelAgentSuggestion } from "./features/travel-agent";
import { TravelAgentPanel } from "./features/travel-agent-view";
import { BookingPanel } from "./features/booking-panel";
// Keep the native diagnostics surface out of production bundles entirely.
// Local development and the explicit Android acceptance build opt in at build
// time; a production APK therefore cannot load this privileged test page even
// if someone guesses its route or asset name.
const ANDROID_DIAGNOSTICS_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true";
const AndroidTestPage = ANDROID_DIAGNOSTICS_ENABLED
  ? lazy(() => import("./android-test"))
  : null;
// The phone simulator shell is a development/acceptance tool too. Keeping it
// out of production avoids shipping an iframe preview route inside the APK.
const ANDROID_PREVIEW_ENABLED = ANDROID_DIAGNOSTICS_ENABLED;
const AndroidPreviewPage = ANDROID_PREVIEW_ENABLED
  ? lazy(() => import("./android-preview"))
  : null;
import "./App.css";
import "./redesign.css";

type ViewId = "trip" | "packing" | "ledger" | "checkin" | "prep" | "account";

type SelfCheckStatus = "ok" | "warn" | "error";
type SelfCheckItem = {
  label: string;
  status: SelfCheckStatus;
  detail: string;
};

type UpdateCheckResult = {
  supported: boolean;
  update: Update | null;
  androidUpdate: AndroidUpdate | null;
  error?: string;
};

/** 构建期注入的应用版本（见 vite.config.ts）。 */
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

function AppSplash({ secureReady, minimumReady }: { secureReady: boolean; minimumReady: boolean }) {
  const status = !secureReady ? "正在恢复安全会话" : !minimumReady ? "正在准备行程空间" : "正在进入途迹";
  return (
    <div className="app-splash" role="status" aria-live="polite" aria-label="正在加载途迹">
      <div className="app-splash__card">
        <div className="app-splash__mark"><MapPin size={28} strokeWidth={2.5} /></div>
        <div className="app-splash__wordmark">途迹<span> / ROUTE</span></div>
        <div className="app-splash__loader" aria-hidden="true"><i /><i /><i /></div>
        <p>{status}<span className="app-splash__ellipsis" aria-hidden="true">...</span></p>
        <small>行程规划 · 出行准备 · 一路安心</small>
      </div>
    </div>
  );
}

const viewTabs: { id: ViewId; label: string; icon: typeof Map }[] = [
  { id: "trip", label: "行程规划", icon: CalendarDays },
  { id: "packing", label: "打包清单", icon: Backpack },
  { id: "ledger", label: "记账结算", icon: Coins },
  { id: "checkin", label: "打卡足迹", icon: Footprints },
  { id: "prep", label: "出行提醒", icon: Megaphone },
];
// 单人私人版不再把「账号」放进主标签：账号是可选能力，入口收进「设置」。
const accountTab: { id: ViewId; label: string; icon: typeof Map } = {
  id: "account",
  label: "账号",
  icon: KeyRound,
};
const allViewTabs = [...viewTabs, accountTab];

const preferences = ["美食", "人文", "自然", "亲子", "摄影", "购物"];
type DestinationOption = {
  name: string;
  type: "城市" | "景点";
  region: string;
};
type AndroidUpdate = {
  version: string;
  url: string;
  name: string;
};

/** Serialize commands that mutate the same native scheduler. React effect
 * cleanup runs immediately before the next effect, but invoke() itself is
 * asynchronous; without a queue an old cancel can arrive after a new schedule.
 */
function enqueueNativeCommand(
  queue: { current: Promise<void> },
  command: () => Promise<unknown>,
) {
  const operation = queue.current.then(command, command);
  queue.current = operation.then(() => undefined, () => undefined);
  return operation;
}

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
  { name: "泉州", type: "城市", region: "福建省" },
  { name: "青岛", type: "城市", region: "山东省" },
  { name: "济南", type: "城市", region: "山东省" },
  { name: "烟台", type: "城市", region: "山东省" },
  { name: "威海", type: "城市", region: "山东省" },
  { name: "大连", type: "城市", region: "辽宁省" },
  { name: "沈阳", type: "城市", region: "辽宁省" },
  { name: "哈尔滨", type: "城市", region: "黑龙江省" },
  { name: "长春", type: "城市", region: "吉林省" },
  { name: "三亚", type: "城市", region: "海南省" },
  { name: "海口", type: "城市", region: "海南省" },
  { name: "北海", type: "城市", region: "广西壮族自治区" },
  { name: "桂林", type: "城市", region: "广西壮族自治区" },
  { name: "昆明", type: "城市", region: "云南省" },
  { name: "大理", type: "城市", region: "云南省" },
  { name: "丽江", type: "城市", region: "云南省" },
  { name: "拉萨", type: "城市", region: "西藏自治区" },
  { name: "张家界", type: "城市", region: "湖南省" },
  { name: "长沙", type: "城市", region: "湖南省" },
  { name: "武汉", type: "城市", region: "湖北省" },
  { name: "宜昌", type: "城市", region: "湖北省" },
  { name: "洛阳", type: "城市", region: "河南省" },
  { name: "开封", type: "城市", region: "河南省" },
  { name: "太原", type: "城市", region: "山西省" },
  { name: "大同", type: "城市", region: "山西省" },
  { name: "兰州", type: "城市", region: "甘肃省" },
  { name: "敦煌", type: "城市", region: "甘肃省" },
  { name: "西宁", type: "城市", region: "青海省" },
  { name: "银川", type: "城市", region: "宁夏回族自治区" },
  { name: "乌鲁木齐", type: "城市", region: "新疆维吾尔自治区" },
  { name: "喀什", type: "城市", region: "新疆维吾尔自治区" },
  { name: "贵阳", type: "城市", region: "贵州省" },
  { name: "安顺", type: "城市", region: "贵州省" },
  { name: "南宁", type: "城市", region: "广西壮族自治区" },
  { name: "呼和浩特", type: "城市", region: "内蒙古自治区" },
  { name: "秦皇岛", type: "城市", region: "河北省" },
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
  { name: "峨眉山", type: "景点", region: "四川乐山" },
  { name: "乐山大佛", type: "景点", region: "四川乐山" },
  { name: "青城山", type: "景点", region: "四川成都" },
  { name: "都江堰景区", type: "景点", region: "四川成都" },
  { name: "四姑娘山", type: "景点", region: "四川阿坝" },
  { name: "若尔盖草原", type: "景点", region: "四川阿坝" },
  { name: "武侯祠", type: "景点", region: "四川成都" },
  { name: "宽窄巷子", type: "景点", region: "四川成都" },
  { name: "三星堆博物馆", type: "景点", region: "四川广汉" },
  { name: "武隆喀斯特旅游区", type: "景点", region: "重庆" },
  { name: "洪崖洞", type: "景点", region: "重庆" },
  { name: "磁器口古镇", type: "景点", region: "重庆" },
  { name: "武当山", type: "景点", region: "湖北十堰" },
  { name: "神农架国家公园", type: "景点", region: "湖北" },
  { name: "恩施大峡谷", type: "景点", region: "湖北恩施" },
  { name: "岳阳楼", type: "景点", region: "湖南岳阳" },
  { name: "衡山", type: "景点", region: "湖南衡阳" },
  { name: "凤凰古城", type: "景点", region: "湖南湘西" },
  { name: "嵩山少林寺", type: "景点", region: "河南登封" },
  { name: "龙门石窟", type: "景点", region: "河南洛阳" },
  { name: "云冈石窟", type: "景点", region: "山西大同" },
  { name: "五台山", type: "景点", region: "山西忻州" },
  { name: "乔家大院", type: "景点", region: "山西晋中" },
  { name: "泰山", type: "景点", region: "山东泰安" },
  { name: "曲阜三孔", type: "景点", region: "山东曲阜" },
  { name: "崂山风景区", type: "景点", region: "山东青岛" },
  { name: "蓬莱阁", type: "景点", region: "山东烟台" },
  { name: "夫子庙秦淮风光带", type: "景点", region: "江苏南京" },
  { name: "中山陵", type: "景点", region: "江苏南京" },
  { name: "拙政园", type: "景点", region: "江苏苏州" },
  { name: "周庄古镇", type: "景点", region: "江苏苏州" },
  { name: "普陀山", type: "景点", region: "浙江舟山" },
  { name: "千岛湖", type: "景点", region: "浙江杭州" },
  { name: "雁荡山", type: "景点", region: "浙江温州" },
  { name: "天台山", type: "景点", region: "浙江台州" },
  { name: "武夷山", type: "景点", region: "福建南平" },
  { name: "土楼（永定·南靖）", type: "景点", region: "福建" },
  { name: "三坊七巷", type: "景点", region: "福建福州" },
  { name: "南普陀寺", type: "景点", region: "福建厦门" },
  { name: "景德镇古窑民俗博览区", type: "景点", region: "江西景德镇" },
  { name: "庐山", type: "景点", region: "江西九江" },
  { name: "三清山", type: "景点", region: "江西上饶" },
  { name: "井冈山", type: "景点", region: "江西吉安" },
  { name: "明孝陵", type: "景点", region: "江苏南京" },
  { name: "婺源篁岭", type: "景点", region: "江西上饶" },
  { name: "南岳衡山", type: "景点", region: "湖南衡阳" },
  { name: "南迦巴瓦峰", type: "景点", region: "西藏林芝" },
  { name: "纳木错", type: "景点", region: "西藏" },
  { name: "珠穆朗玛峰国家级自然保护区", type: "景点", region: "西藏日喀则" },
  { name: "林芝桃花沟", type: "景点", region: "西藏林芝" },
  { name: "普达措国家公园", type: "景点", region: "云南迪庆" },
  { name: "西双版纳热带植物园", type: "景点", region: "云南西双版纳" },
  { name: "腾冲热海", type: "景点", region: "云南保山" },
  { name: "元阳梯田", type: "景点", region: "云南红河" },
  { name: "泸沽湖", type: "景点", region: "云南丽江 / 四川凉山" },
  { name: "青海湖", type: "景点", region: "青海" },
  { name: "茶卡盐湖", type: "景点", region: "青海海西" },
  { name: "可可西里", type: "景点", region: "青海玉树" },
  { name: "鸣沙山月牙泉", type: "景点", region: "甘肃敦煌" },
  { name: "嘉峪关关城", type: "景点", region: "甘肃嘉峪关" },
  { name: "张掖七彩丹霞", type: "景点", region: "甘肃张掖" },
  { name: "麦积山石窟", type: "景点", region: "甘肃天水" },
  { name: "额济纳胡杨林", type: "景点", region: "内蒙古阿拉善" },
  { name: "呼伦贝尔大草原", type: "景点", region: "内蒙古呼伦贝尔" },
  { name: "阿尔山国家森林公园", type: "景点", region: "内蒙古兴安盟" },
  { name: "哈尔滨冰雪大世界", type: "景点", region: "黑龙江哈尔滨" },
  { name: "漠河北极村", type: "景点", region: "黑龙江大兴安岭" },
  { name: "长白山天池", type: "景点", region: "吉林" },
  { name: "伪满皇宫博物院", type: "景点", region: "吉林长春" },
  { name: "五大连池风景区", type: "景点", region: "黑龙江黑河" },
  { name: "盘锦红海滩", type: "景点", region: "辽宁盘锦" },
  { name: "秦皇岛山海关", type: "景点", region: "河北秦皇岛" },
  { name: "承德避暑山庄", type: "景点", region: "河北承德" },
  { name: "白洋淀", type: "景点", region: "河北保定" },
  { name: "天山天池", type: "景点", region: "新疆昌吉" },
  { name: "喀纳斯景区", type: "景点", region: "新疆阿勒泰" },
  { name: "那拉提旅游风景区", type: "景点", region: "新疆伊犁" },
  { name: "赛里木湖", type: "景点", region: "新疆博尔塔拉" },
  { name: "独库公路", type: "景点", region: "新疆" },
  { name: "火焰山景区", type: "景点", region: "新疆吐鲁番" },
  { name: "梵净山", type: "景点", region: "贵州铜仁" },
  { name: "荔波小七孔", type: "景点", region: "贵州黔南" },
  { name: "西江千户苗寨", type: "景点", region: "贵州黔东南" },
  { name: "万峰林", type: "景点", region: "贵州兴义" },
  { name: "涠洲岛", type: "景点", region: "广西北海" },
  { name: "德天跨国瀑布", type: "景点", region: "广西崇左" },
  { name: "龙脊梯田", type: "景点", region: "广西桂林" },
  { name: "银子岩", type: "景点", region: "广西桂林" },
  { name: "三江程阳八寨", type: "景点", region: "广西柳州" },
  { name: "南山文化旅游区", type: "景点", region: "海南三亚" },
  { name: "蜈支洲岛", type: "景点", region: "海南三亚" },
  { name: "分界洲岛", type: "景点", region: "海南陵水" },
  { name: "五指山热带雨林", type: "景点", region: "海南五指山" },
  { name: "广州长隆旅游度假区", type: "景点", region: "广东广州" },
  { name: "丹霞山", type: "景点", region: "广东韶关" },
  { name: "开平碉楼", type: "景点", region: "广东江门" },
  { name: "潮州古城", type: "景点", region: "广东潮州" },
  { name: "深圳世界之窗", type: "景点", region: "广东深圳" },
  { name: "南澳岛", type: "景点", region: "广东汕头" },
  { name: "福建土楼", type: "景点", region: "福建" },
  { name: "泉州开元寺", type: "景点", region: "福建泉州" },
  { name: "洛阳白马寺", type: "景点", region: "河南洛阳" },
  { name: "殷墟博物馆", type: "景点", region: "河南安阳" },
  { name: "西安城墙", type: "景点", region: "陕西西安" },
  { name: "华山", type: "景点", region: "陕西渭南" },
  { name: "法门寺", type: "景点", region: "陕西宝鸡" },
  { name: "陕西历史博物馆", type: "景点", region: "陕西西安" },
  { name: "大雁塔", type: "景点", region: "陕西西安" },
  { name: "西岳华山", type: "景点", region: "陕西渭南" },
  { name: "东方明珠广播电视塔", type: "景点", region: "上海" },
  { name: "豫园", type: "景点", region: "上海" },
  { name: "国家博物馆", type: "景点", region: "北京" },
  { name: "圆明园遗址公园", type: "景点", region: "北京" },
  { name: "环球度假区", type: "景点", region: "北京" },
  { name: "香格里拉", type: "城市", region: "云南省" },
  { name: "阿坝", type: "城市", region: "四川省" },
  { name: "伊犁", type: "城市", region: "新疆维吾尔自治区" },
  { name: "恩施", type: "城市", region: "湖北省" },
  { name: "婺源", type: "城市", region: "江西省" },
  { name: "平潭", type: "城市", region: "福建省" },
];
type ProviderId = "openai" | "deepseek" | "zhipu" | "qwen" | "moonshot" | "siliconflow" | "custom";
const AI_KEYS_WRITE_FAILURE_KEY = "route-ai-keys-write-failed";
type MapProvider = "amap" | "baidu" | "tencent";
type MapAppInfo = { packageName: string; label: string; short: string };
const mapApps: Record<MapProvider, MapAppInfo> = {
  amap: { packageName: "com.autonavi.minimap", label: "高德地图", short: "高德" },
  baidu: { packageName: "com.baidu.BaiduMap", label: "百度地图", short: "百度" },
  tencent: { packageName: "com.tencent.map", label: "腾讯地图", short: "腾讯" },
};
const mapProviderOrder: MapProvider[] = ["amap", "baidu", "tencent"];

const RAIL_BOOKING_URL = "https://www.12306.cn/index/";
const FLIGHT_BOOKING_URL = "https://flights.ctrip.com/online/channel/domestic";
const HOTEL_BOOKING_URL = "https://hotels.ctrip.com/";

/** 把原生层返回的包名列表转成中文标签，用于界面上的检测状态提示。 */
function mapAppLabels(packages: string[] | null) {
  if (!packages) return "";
  return mapProviderOrder
    .filter((provider) => packages.includes(mapApps[provider].packageName))
    .map((provider) => mapApps[provider].label)
    .join("、");
}
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
/**
 * 单人版只保留一个主要 AI 服务商。
 * 默认 DeepSeek：接口兼容 OpenAI Chat Completions、国内可直连、价格低。
 * 若 provider 列表里没有该 id，回退到列表首位，避免 undefined。
 */
const PRIMARY_PROVIDER_ID: ProviderId = "deepseek";
const primaryProvider = providers.find((item) => item.id === PRIMARY_PROVIDER_ID) ?? defaultProvider;
function storedString(key: string, fallback: string) {
  const value = stored<unknown>(key, fallback);
  return typeof value === "string" ? value : fallback;
}
function storedProviderId(): ProviderId {
  // 单人版锁定单一服务商：即使旧版本存过别的 id，也回落到主服务商。
  if (!MULTI_PROVIDER_ENABLED) return primaryProvider.id;
  const value = stored<unknown>("route-ai-provider", defaultProvider.id);
  return providers.some((provider) => provider.id === value)
    ? value as ProviderId
    : defaultProvider.id;
}
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
/** 单日活动费用合计（与 estimatedCost 一致，为全部同行者合计）。 */
function dayCost(day: { activities: { estimatedCost: number }[] }) {
  return day.activities.reduce((sum, item) => sum + item.estimatedCost, 0);
}
function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}
function webMapUrl(provider: MapProvider, query: string, city: string) {
  const keyword = encodeURIComponent(query);
  const region = encodeURIComponent(city);
  if (provider === "amap") {
    return `https://www.amap.com/search?query=${keyword}&city=${region}`;
  }
  if (provider === "baidu") {
    return `https://map.baidu.com/search?query=${keyword}&region=${region}`;
  }
  return `https://map.qq.com/?type=poi&keyword=${keyword}&city=${region}`;
}

function webSearchUrl(
  provider: MapProvider,
  destination: string,
  location: string,
) {
  return webMapUrl(provider, `${destination} ${location}`.trim(), destination);
}

/** 单点：地图 App 内关键词定位，无需坐标。 */
function appSearchUrl(
  provider: MapProvider,
  destination: string,
  location: string,
) {
  const query = encodeURIComponent(`${destination} ${location}`.trim());
  if (provider === "amap") {
    return `androidamap://keywordNavi?sourceApplication=luyou&keyword=${query}&style=2`;
  }
  if (provider === "baidu") {
    return `baidumap://map/geocoder?address=${query}&src=android.luyou.planner`;
  }
  return `qqmap://map/search?keyword=${query}&referer=luyou`;
}

/** 两点：地图 App 内直接出路线，起点/终点用 POI 名称。 */
function appRouteUrl(provider: MapProvider, from: string, to: string) {
  const start = encodeURIComponent(from);
  const end = encodeURIComponent(to);
  if (provider === "amap") {
    return `androidamap://route?sourceApplication=luyou&sname=${start}&dname=${end}&dev=0&t=0`;
  }
  if (provider === "baidu") {
    return `baidumap://map/direction?origin=${start}&destination=${end}&mode=driving&src=android.luyou.planner`;
  }
  return `qqmap://map/routeplan?type=drive&from=${start}&to=${end}&referer=luyou`;
}

/**
 * 先探测目标地图 App 是否已安装，命中则用显式 Intent 直接拉起（浏览器不参与）；
 * 未安装或启动失败时回落到网页地址。
 */
async function openMap(
  provider: MapProvider,
  target: { appUrl: string; webUrl: string },
) {
  if (isTauri() && /Android/i.test(navigator.userAgent)) {
    try {
      const result = await invoke<{ launched: boolean; reason?: string }>(
        "plugin:map-launcher|open_map",
        { url: target.appUrl, packageName: mapApps[provider].packageName },
      );
      if (result?.launched) return;
    } catch {
      // 原生插件不可用时静默回落，不打断用户操作。
    }
  }
  await openExternal(target.webUrl);
}

async function openLocationMap(
  provider: MapProvider,
  destination: string,
  location: string,
) {
  await openMap(provider, {
    appUrl: appSearchUrl(provider, destination, location),
    webUrl: webSearchUrl(provider, destination, location),
  });
}

/** 整程总览取首末两点，交给地图 App 做路线规划。 */
function tripRoutePoints(trip: Trip) {
  return trip.days
    .flatMap((item) => item.activities)
    .map((activity) => (activity.location || activity.title || "").trim())
    .filter(Boolean)
    .filter((point, index, list) => list.indexOf(point) === index);
}

async function openTripRoute(provider: MapProvider, trip: Trip) {
  const points = tripRoutePoints(trip);
  if (points.length < 2) return;
  const from = points[0];
  const to = points[points.length - 1];
  await openMap(provider, {
    appUrl: appRouteUrl(provider, from, to),
    webUrl: webMapUrl(provider, `${from} ${to}`.trim(), trip.destination),
  });
}

async function openExternal(url: string) {
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const backupCurrencyCodes = new Set(currencies.map((item) => item.code));
const backupExpenseCategories = new Set(expenseCategories);

function finiteOptional(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isBackupDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isBackupWeather(value: unknown): value is Weather {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<Weather>;
  return isBackupDate(item.date) &&
    typeof item.label === "string" && item.label.length <= 80 &&
    typeof item.summary === "string" && item.summary.length <= 500 &&
    finiteOptional(item.min) && finiteOptional(item.max) && finiteOptional(item.rain) && finiteOptional(item.code);
}

function isBackupExpense(value: unknown): value is Expense {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<Expense>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 120 &&
    isBackupDate(item.date) &&
    typeof item.category === "string" && backupExpenseCategories.has(item.category as Expense["category"]) &&
    typeof item.title === "string" && item.title.trim().length > 0 && item.title.length <= 160 &&
    typeof item.amount === "number" && Number.isFinite(item.amount) && item.amount >= 0 && item.amount <= 10_000_000 &&
    typeof item.currency === "string" && backupCurrencyCodes.has(item.currency as Expense["currency"]) &&
    typeof item.rate === "number" && Number.isFinite(item.rate) && item.rate >= 0 && item.rate <= 1_000_000 &&
    typeof item.paidBy === "string" && item.paidBy.length <= 120 &&
    typeof item.shares === "number" && Number.isInteger(item.shares) && item.shares >= 1 && item.shares <= 100 &&
    (item.participants === undefined || (Array.isArray(item.participants) && item.participants.length <= 100 && item.participants.every((name) => typeof name === "string" && name.length > 0 && name.length <= 120)));
}

function isBackupCheckIns(value: unknown): value is CheckInMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).length <= 1_000 && Object.entries(value).every(([key, record]) =>
    key.length > 0 && key.length <= 4_096 && key !== "__proto__" && key !== "constructor" && key !== "prototype" &&
    Boolean(record) && typeof record === "object" && !Array.isArray(record) &&
    typeof (record as CheckInMap[string]).at === "string" &&
    (record as CheckInMap[string]).at.length <= 80 &&
    !Number.isNaN(Date.parse((record as CheckInMap[string]).at)) &&
    typeof (record as CheckInMap[string]).note === "string" &&
    (record as CheckInMap[string]).note.length <= 2_000,
  );
}

function isBackupPrepState(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).length <= 100 && Object.entries(value).every(([key, checked]) =>
    key.length > 0 && key.length <= 100 && key !== "__proto__" && key !== "constructor" && key !== "prototype" && typeof checked === "boolean",
  );
}

function isBackupPackingItems(value: unknown): value is PackingItem[] {
  if (!Array.isArray(value) || value.length > MAX_PACKING_ITEMS) return false;
  const sanitized = sanitizePackingItems(value);
  // The sanitizer is also used for local storage recovery. Backups must be
  // rejected when any entry would be discarded instead of silently importing
  // a partial list.
  return sanitized !== undefined && sanitized.length === value.length;
}

// Diagnostic routes must not mount the product's effects: a restored session
// would otherwise schedule/cancel real reminders while testing native plugins.
function App() {
  // Native diagnostics can invoke storage, notifications, WorkManager and the
  // installer. Keep the route in development/local acceptance builds only;
  // production APKs must not expose a privileged test surface by URL.
  if (ANDROID_DIAGNOSTICS_ENABLED && AndroidTestPage && window.location.pathname === "/android-test") {
    return <Suspense fallback={<AppSplash secureReady minimumReady />}><AndroidTestPage /></Suspense>;
  }
  if (ANDROID_PREVIEW_ENABLED && AndroidPreviewPage && window.location.pathname === "/android-preview") {
    return <Suspense fallback={<AppSplash secureReady minimumReady />}><AndroidPreviewPage /></Suspense>;
  }
  return <PlannerApp />;
}

function PlannerApp() {
  const [input, setInput] = useState<PlannerInput>(() => {
    const parsed = plannerInputSchema.safeParse(stored<unknown>("route-input", defaultInput));
    return parsed.success ? parsed.data : defaultInput;
  });
  const [trip, setTrip] = useState<Trip>(() => {
    const parsed = tripSchema.safeParse(stored<unknown>("route-trip", null));
    return parsed.success ? parsed.data : createSampleTrip();
  });
  const [activeDay, setActiveDay] = useState(0);
  const [apiKeys, setApiKeys] = useState<Partial<Record<ProviderId, string>>>(() => {
    // Only Android has an explicit encrypted vault. Desktop and browser
    // sessions intentionally start with no persisted provider secrets.
    const saved: Partial<Record<ProviderId, string>> = {};
    return Object.fromEntries(
      Object.entries(saved).filter(([, value]) => typeof value === "string" && value.length <= 512),
    ) as Partial<Record<ProviderId, string>>;
  });
  const [aiKeysReady, setAiKeysReady] = useState(() => !isAndroidSecureStore());
  const aiKeysVersion = useRef(0);
  const aiKeysQueue = useRef<Promise<void>>(Promise.resolve());
  const aiKeysTimer = useRef<number | null>(null);
  const pendingAiKeys = useRef<Partial<Record<ProviderId, string>> | null>(null);
  function queueAiKeysWrite(value: Partial<Record<ProviderId, string>>) {
    const operation = aiKeysQueue.current.then(() => writeSecure("route-ai-keys", value));
    aiKeysQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function flushAiKeysWrite() {
    if (aiKeysTimer.current !== null) {
      window.clearTimeout(aiKeysTimer.current);
      aiKeysTimer.current = null;
    }
    const value = pendingAiKeys.current;
    pendingAiKeys.current = null;
    if (!value || !isAndroidSecureStore()) return;
    void queueAiKeysWrite(value).then((ok) => {
      if (!ok) {
        // Prevent a stale plaintext migration copy from resurrecting after a
        // failed Keystore write. The current edit must be entered again.
        saveJson(AI_KEYS_WRITE_FAILURE_KEY, true);
        try { localStorage.removeItem("route-ai-keys"); } catch { /* best effort */ }
        setError("AI Key 保存失败，请检查设备存储空间");
        return;
      }
      saveJson(AI_KEYS_WRITE_FAILURE_KEY, false);
      try { localStorage.removeItem("route-ai-keys"); } catch { /* ignore */ }
    });
  }
  function scheduleAiKeysWrite(value: Partial<Record<ProviderId, string>>) {
    // A Keystore migration read may still be pending during startup. Mark the
    // edit before debouncing so that the late read cannot overwrite the value
    // the user just entered.
    aiKeysVersion.current += 1;
    pendingAiKeys.current = value;
    if (aiKeysTimer.current !== null) window.clearTimeout(aiKeysTimer.current);
    aiKeysTimer.current = window.setTimeout(() => {
      aiKeysTimer.current = null;
      flushAiKeysWrite();
    }, 350);
  }
  // A WebView can be torn down immediately when Android backgrounds or kills
  // the activity. Flush before that boundary instead of leaving the last
  // debounced key update only in memory.
  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushAiKeysWrite();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushWhenHidden);
      flushAiKeysWrite();
    };
  }, []);
  useEffect(() => {
    if (!isAndroidSecureStore()) return;
    const startVersion = aiKeysVersion.current;
    const blockedLegacyMigration = stored<boolean>(AI_KEYS_WRITE_FAILURE_KEY, false) === true;
    let legacy: Partial<Record<ProviderId, string>> = {};
    try {
      const raw = localStorage.getItem("route-ai-keys");
      legacy = raw ? JSON.parse(raw) as Partial<Record<ProviderId, string>> : {};
    } catch { /* ignore malformed legacy data */ }
    void readSecureEntry<Partial<Record<ProviderId, string>>>("route-ai-keys").then(async (secure) => {
      // Do not let a slow Keystore read overwrite a key edited while the app was starting.
      if (aiKeysVersion.current !== startVersion) return;
      if (!secure.ok) {
        setError("无法读取 Android 安全存储，AI Key 未恢复。请检查设备锁屏状态和存储空间后重试。");
        return;
      }
      // An encrypted empty object means the user intentionally cleared all
      // keys. Only a genuinely missing secure entry may use the legacy copy.
      const saved = secure.ok && secure.found ? (secure.value ?? {}) : {};
      const candidate = secure.ok && !secure.found && !blockedLegacyMigration ? legacy : saved;
      const filtered = Object.fromEntries(
        Object.entries(candidate).filter(([, value]) => typeof value === "string" && value.length <= 512),
      ) as Partial<Record<ProviderId, string>>;
      if (aiKeysVersion.current !== startVersion) return;
      setApiKeys(filtered);
      if (secure.ok && secure.found) saveJson(AI_KEYS_WRITE_FAILURE_KEY, false);
      if (blockedLegacyMigration && secure.ok && !secure.found) {
        setError("上次 AI Key 未能安全保存，已阻止旧 Key 自动恢复，请重新输入并保存。");
      }
      if (secure.ok && !secure.found && Object.keys(filtered).length && await queueAiKeysWrite(filtered)) {
        if (aiKeysVersion.current !== startVersion) return;
        saveJson(AI_KEYS_WRITE_FAILURE_KEY, false);
        try { localStorage.removeItem("route-ai-keys"); } catch { /* ignore */ }
      }
    }).finally(() => setAiKeysReady(true));
  }, []);
  const [providerId, setProviderId] = useState<ProviderId>(() =>
    storedProviderId(),
  );
  const [endpoint, setEndpoint] = useState(() =>
    storedString("route-ai-endpoint", MULTI_PROVIDER_ENABLED ? defaultProvider.endpoint : primaryProvider.endpoint),
  );
  const [model, setModel] = useState(() =>
    storedString("route-ai-model", MULTI_PROVIDER_ENABLED ? defaultProvider.model : primaryProvider.model),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 应用锁：冷启动时若已启用则先锁住；回来时（后台超过 60 秒）再次上锁。
  const [lockEnabled, setLockEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const hiddenAt = useRef(0);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [androidUpdate, setAndroidUpdate] = useState<AndroidUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [selfCheckBusy, setSelfCheckBusy] = useState(false);
  const [selfCheckItems, setSelfCheckItems] = useState<SelfCheckItem[]>([]);
  const [selfCheckAt, setSelfCheckAt] = useState("");
  const selfCheckOperationLock = useRef(false);
  const updateCheckVersion = useRef(0);
  const updateOperationLock = useRef(false);
  const [installedMapApps, setInstalledMapApps] = useState<string[] | null>(null);
  const [mapAppError, setMapAppError] = useState<string | null>(null);
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
  const [budgetNotice, setBudgetNotice] = useState("");
  const [weather, setWeather] = useState<Weather[]>([]);
  const [currentWeather, setCurrentWeather] = useState<CurrentWeather>();
  const [weatherStatus, setWeatherStatus] = useState("");
  const [weatherUpdatedAt, setWeatherUpdatedAt] = useState("");
  const [weatherStale, setWeatherStale] = useState(false);
  const weatherQueryKey = useRef("");
  const [agentNotice, setAgentNotice] = useState("");
  const [agentProposal, setAgentProposal] = useState<AgentProposal | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState("");

  useEffect(() => {
    const onStorageWriteFailed = () => {
      setError("设备存储不可用，最近的修改可能未保存。请检查存储空间后重试。\n你也可以先导出行程备份，避免数据丢失。");
    };
    window.addEventListener(STORAGE_WRITE_FAILED_EVENT, onStorageWriteFailed);
    return () => window.removeEventListener(STORAGE_WRITE_FAILED_EVENT, onStorageWriteFailed);
  }, []);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherRefreshTick, setWeatherRefreshTick] = useState(0);
  const [locationCoords, setLocationCoords] = useState<{ latitude: number; longitude: number }>();
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [highlightedDestination, setHighlightedDestination] = useState(0);
  const [view, setView] = useState<ViewId>(() => DEFAULT_VIEW);
  const [packingRevision, setPackingRevision] = useState(0);
  // 账号态：登录只负责账号服务；本机离线功能不因登出而丢失。
  const auth = useAuth();
  const reminderCommandQueue = useRef<Promise<void>>(Promise.resolve());
  const weatherCommandQueue = useRef<Promise<void>>(Promise.resolve());
  const nativeAiSettings = isTauri();
  // 单人版没有账号门槛；多用户构建仍要等登录后才注册定位、提醒和后台天气。
  // 这条条件必须与 requiresAccount() 共用，避免私人 Android 包出现“能规划但不提醒”的半可用状态。
  const localFeaturesReady = auth.ready && (!requiresAccount() || Boolean(auth.user));
  // Android uses the Keystore-backed bridge. Desktop Tauri currently keeps
  // provider keys in memory only; do not claim persistence in that build.
  const aiKeysPersisted = isAndroidSecureStore();
  // Remove values written by older builds so an upgrade cannot leave an API
  // key in WebView localStorage. Android's Keystore path is authoritative.
  useEffect(() => {
    if (isAndroidSecureStore()) return;
    try { localStorage.removeItem("route-ai-keys"); } catch { /* best effort */ }
  }, []);
  const [startupMinimumReady, setStartupMinimumReady] = useState(false);
  const { preferences: uiPreferences, updatePreferences, play } = useUiFeedback();
  useEffect(() => {
    const timer = window.setTimeout(() => setStartupMinimumReady(true), 650);
    return () => window.clearTimeout(timer);
  }, []);
  // 单人私人版：账号页不是落地页，也不参与展示门控。
  // 多用户构建：未登录时只能看到账号页。
  const accountGate = requiresAccount() && !auth.user;
  const displayView: ViewId = accountGate ? "account" : view;
  // 应用锁启动检查：读一次配置，启用则立即上锁（不等其它异步初始化）。
  useEffect(() => {
    let alive = true;
    void readLockConfig().then((config) => {
      if (!alive) return;
      const enabled = Boolean(config?.enabled);
      setLockEnabled(enabled);
      if (enabled) setLocked(true);
    });
    return () => { alive = false; };
  }, []);
  // 回到前台：后台超过 60 秒就重新上锁，短暂切走（回消息/看时间）不打断。
  // 例外：系统分享/文件选择这类用户主动发起的交互（见 share.ts），
  // 不能因为用户在系统面板里挑应用挑得久就把人锁在门外。
  useEffect(() => {
    if (!lockEnabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      // 令牌必须每次回到前台都消费：若只在"超过 60 秒"时才取，
      // 一次 30 秒的分享会把它留到下一次真正的离开，等于豁免错了对象。
      const exemptOnce = consumeSystemInteraction();
      if (away > 60_000 && !exemptOnce) setLocked(true);
      hiddenAt.current = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [lockEnabled]);
  const visibleViewTabs = SINGLE_USER ? viewTabs : allViewTabs;
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const namespace = tripNamespace(trip);
  const [expenses, setExpenses] = useStoredState<Expense[]>(
    `route-ledger:${namespace}`,
    [],
    sanitizeExpenses,
  );
  const [checkIns, setCheckIns] = useStoredState<CheckInMap>(
    `route-checkin:${namespace}`,
    {},
    sanitizeCheckIns,
  );
  const [prepState, setPrepState] = useStoredState<Record<string, boolean>>(
    `route-prep:${namespace}`,
    {},
    sanitizePrepState,
  );
  const [agentReminders, setAgentReminders] = useStoredState<string[]>(
    `route-agent-reminders:${namespace}`,
    [],
    sanitizeAgentReminders,
  );
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
  const budget = budgetStatus(trip, input.budget, input.travelers, input.days);
  const perPerson = total / Math.max(1, input.travelers);

  useEffect(() => {
    saveJson("route-input", input);
  }, [input]);
  useEffect(() => {
    saveJson("route-trip", trip);
  }, [trip]);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const version = ++updateCheckVersion.current;
    const android = /Android/i.test(navigator.userAgent);
    if (android) {
      invoke<AndroidUpdate | null>("plugin:android-updater|check")
        .then((update) => {
          if (!cancelled && version === updateCheckVersion.current && update) setAndroidUpdate(update);
        })
        .catch(() => {});
    } else {
      check()
        .then((update) => {
          if (!cancelled && version === updateCheckVersion.current && update) setAvailableUpdate(update);
          else if (update) void update.close().catch(() => {});
        })
        .catch(() => {
          // Update checks are best effort and should not interrupt planning.
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!navigator.geolocation) return;
    if (!localFeaturesReady) {
      setLocationCoords(undefined);
      return;
    }
    let cancelled = false;
    const locate = () => {
      if (cancelled) return;
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!cancelled) setLocationCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        },
        () => {
          if (!cancelled) setLocationCoords(undefined);
        },
        { enableHighAccuracy: false, maximumAge: 15 * 60 * 1000, timeout: 8000 },
      );
    };
    const isAndroid = isTauri() && /Android/i.test(navigator.userAgent);
    if (isAndroid) {
      invoke<{ granted?: boolean }>("plugin:location-permission|request_location_permission")
        .catch(() => null)
        .finally(() => {
          // The Android permission dialog is asynchronous and WebView may
          // receive its callback a moment after the native command resolves.
          window.setTimeout(locate, 250);
        });
    } else {
      locate();
    }
    return () => {
      cancelled = true;
    };
  }, [localFeaturesReady]);

  // 天气应用常见的前台刷新策略：回到页面立即更新，前台每 10 分钟更新一次。
  // 定时器只在 WebView 可见时工作，避免安卓后台耗电和无意义请求。
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") setWeatherRefreshTick((value) => value + 1);
    };
    const timer = window.setInterval(refreshWhenVisible, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !/Android/i.test(navigator.userAgent)) return;
    let cancelled = false;
    // Native reminders contain the destination and can appear on the lock
    // screen. Do not keep them alive after logout; the effect below will
    // schedule them again once the secure session is restored after login.
    if (!localFeaturesReady) {
      if (auth.ready && requiresAccount()) {
        void enqueueNativeCommand(reminderCommandQueue, () =>
          invoke("plugin:notifications|cancel_all_notifications"),
        ).catch(() => {});
      }
      return () => { cancelled = true; };
    }
    const firstDate = trip.days[0]?.date;
    if (!firstDate) {
      void enqueueNativeCommand(reminderCommandQueue, () =>
        invoke("plugin:notifications|cancel_all_notifications"),
      ).catch(() => {});
      return () => { cancelled = true; };
    }
    const start = new Date(`${firstDate}T09:00:00`).getTime();
    const atMillis = start - 24 * 60 * 60 * 1000;
    if (!Number.isFinite(atMillis) || atMillis <= Date.now()) {
      // There may be a reminder from an earlier destination/date whose title
      // and timestamp no longer match this trip. Clear the native set rather
      // than trying to guess the historical key.
      void enqueueNativeCommand(reminderCommandQueue, () =>
        invoke("plugin:notifications|cancel_all_notifications"),
      ).catch(() => {});
      return () => { cancelled = true; };
    }
    // 将目的地放进标题，避免不同目的地在同一时间共享原生提醒 ID。
    // 原生通知标题上限为 120 个字符，超长目的地按上限截断。
    const title = `明天开始行程 · ${trip.destination}`.slice(0, 120);
    const legacyTitle = "明天开始行程";
    const body = `${trip.destination} 的行程将在明天开始，请核对预约、天气和交通。`;
    const scheduleReminder = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      void enqueueNativeCommand(reminderCommandQueue, async () => {
        if (cancelled) return;
        // 清理旧版本固定标题的同一条提醒，避免升级后双重通知。
        await invoke("plugin:notifications|cancel_notification", {
          title: legacyTitle,
          atMillis,
        }).catch(() => {});
        if (cancelled) return;
        await invoke("plugin:notifications|schedule_notification", {
          title,
          body,
          atMillis,
        });
      }).catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message.includes("通知") || message.includes("权限")
          ? message
          : `行程提醒未开启：${message}`);
      });
    };
    const retryAfterPermission = () => {
      if (document.visibilityState === "visible") scheduleReminder();
    };
    scheduleReminder();
    window.addEventListener("focus", retryAfterPermission);
    window.addEventListener("pageshow", retryAfterPermission);
    document.addEventListener("visibilitychange", retryAfterPermission);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", retryAfterPermission);
      window.removeEventListener("pageshow", retryAfterPermission);
      document.removeEventListener("visibilitychange", retryAfterPermission);
      void enqueueNativeCommand(reminderCommandQueue, async () => {
        await invoke("plugin:notifications|cancel_notification", { title, atMillis }).catch(() => {});
        await invoke("plugin:notifications|cancel_notification", { title: legacyTitle, atMillis }).catch(() => {});
      }).catch(() => {});
    };
  }, [localFeaturesReady, auth.ready, trip.destination, trip.days[0]?.date]);

  useEffect(() => {
    if (!isTauri() || !/Android/i.test(navigator.userAgent)) return;
    let cancelled = false;
    if (!localFeaturesReady) {
      if (auth.ready && requiresAccount()) {
        void enqueueNativeCommand(weatherCommandQueue, () =>
          invoke("plugin:weather-background|cancel_weather_monitor"),
        ).catch(() => {});
      }
      return () => { cancelled = true; };
    }
    const backgroundDates = dates.split(",").filter(Boolean);
    if (!trip.destination.trim() || !backgroundDates.length) {
      void enqueueNativeCommand(weatherCommandQueue, () =>
        invoke("plugin:weather-background|cancel_weather_monitor"),
      ).catch(() => {});
      return;
    }
    const registerWeather = createWeatherRegistration({
      readStatus: () => invoke<WeatherMonitorStatus>("plugin:weather-background|weather_monitor_status"),
      isActive: () => !cancelled && document.visibilityState !== "hidden",
      schedule: (immediate) => invoke("plugin:weather-background|schedule_weather_monitor", {
        destination: trip.destination,
        dates: backgroundDates,
        immediate,
      }),
    });
    const scheduleWeatherMonitor = (initial: boolean) => {
      if (cancelled || document.visibilityState === "hidden") return;
      void enqueueNativeCommand(weatherCommandQueue, () => registerWeather(initial)).catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message.includes("通知") || message.includes("权限")
          ? message
          : `天气后台监测未开启：${message}`);
      });
    };
    const retryAfterPermission = () => {
      if (document.visibilityState === "visible") scheduleWeatherMonitor(false);
    };
    // The initial registration (or a changed trip) gets one immediate check.
    // Resume checks are throttled, except when notification access is restored.
    scheduleWeatherMonitor(true);
    window.addEventListener("focus", retryAfterPermission);
    window.addEventListener("pageshow", retryAfterPermission);
    document.addEventListener("visibilitychange", retryAfterPermission);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", retryAfterPermission);
      window.removeEventListener("pageshow", retryAfterPermission);
      document.removeEventListener("visibilitychange", retryAfterPermission);
      void enqueueNativeCommand(weatherCommandQueue, () =>
        invoke("plugin:weather-background|cancel_weather_monitor"),
      ).catch(() => {});
    };
  }, [localFeaturesReady, auth.ready, trip.destination, dates]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const queryKey = `${trip.destination.trim()}|${dates}`;
    // A new destination/date set must never render the previous trip's
    // forecast while the network request is in flight. Keep the current
    // weather during a location-only refresh so returning to the page does
    // not cause an unnecessary blank state.
    if (weatherQueryKey.current !== queryKey) {
      weatherQueryKey.current = queryKey;
      setWeather([]);
      setCurrentWeather(undefined);
      setWeatherUpdatedAt("");
      setWeatherStale(false);
    }
    setWeatherLoading(true);
    setWeatherStatus(weather.length ? "正在更新实时天气" : "正在获取实时天气");
    getWeather(trip.destination, dates.split(","), { ...locationCoords, signal: controller.signal })
      .then((result) => {
        if (!cancelled) {
          setWeather(result.days);
          setCurrentWeather(result.current);
          setWeatherStatus(result.message);
          setWeatherUpdatedAt(result.updatedAt);
          setWeatherStale(Boolean(result.stale));
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && (reason as Error)?.name !== "AbortError") {
          setWeatherStatus(online ? "天气暂不可用，可点击出行提醒重试" : "当前离线，显示本地已保存行程");
        }
      })
      .finally(() => {
        if (!cancelled) setWeatherLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trip.destination, dates, locationCoords?.latitude, locationCoords?.longitude, online, weatherRefreshTick]);

  function change<K extends keyof PlannerInput>(
    key: K,
    value: PlannerInput[K],
  ) {
    setInput((previous) => ({ ...previous, [key]: value }));
  }
  function applyWinterBreakPreset() {
    const now = new Date();
    // 以每年 1 月 20 日作为可编辑的寒假起点，避免替用户猜学校的确切放假日。
    const candidate = new Date(now.getFullYear(), 0, 20);
    if (candidate.getTime() <= now.getTime()) candidate.setFullYear(candidate.getFullYear() + 1);
    const startDate = `${candidate.getFullYear()}-01-20`;
    setInput((previous) => ({
      ...previous,
      startDate,
      days: 5,
      travelers: Math.max(2, previous.travelers),
      pace: "适中",
      interests: previous.interests.length ? previous.interests : ["美食", "人文"],
      notes: previous.notes.trim() || "和同学结伴出游，优先安排交通方便、适合多人同行的路线，预留购票和住宿预算。",
    }));
    setError("");
    setBudgetNotice("已套用寒假 5 日模板；请把出发日期改成学校实际放假时间，再生成攻略。 ");
  }
  useEffect(() => {
    if (requiresAccount() && !auth.user && view !== "account") {
      play("switch");
      setView("account");
    }
  }, [auth.user, view, play]);
  useEffect(() => {
    const onButtonClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button") && !(target as HTMLButtonElement).disabled) play("click");
    };
    document.addEventListener("click", onButtonClick, true);
    return () => document.removeEventListener("click", onButtonClick, true);
  }, [play]);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  const countdown = tripCountdown(trip);
  const advisories = weatherAdvisories(weather, trip, currentWeather);
  const liveAdvice = currentWeatherAdvice(currentWeather);
  const issues = auditTrip(trip, weather, input.budget);
  const agentSuggestions = buildTravelAgentSuggestions({
    trip,
    weather,
    advisories,
    issues,
    weatherStale,
  });
  function agentContext() {
    const completed = trip.days.flatMap((item, dayIndex) => item.activities.map((_, index) =>
      readCheckIn(checkIns, trip, dayIndex, index) ? { day: dayIndex, index } : null)).filter(Boolean) as { day: number; index: number }[];
    return {
      instruction: "请检查当前行程，优先处理天气、预算和体检风险，给出可确认执行的安全调整。",
      trip, budget: input.budget, travelers: input.travelers,
      spent: expenses.reduce((sum, item) => sum + item.amount * item.rate, 0), completed,
      reminders: agentReminders,
      issues: issues.map((item) => ({ level: item.level, title: item.title, detail: item.detail })),
      weather: { source: "Open-Meteo" as const, updatedAt: weatherUpdatedAt || "未知", stale: weatherStale, days: weather },
    };
  }
  async function askAgentAi() {
    const context = agentContext();
    setAgentBusy(true); setAgentError(""); setAgentProposal(null);
    try {
      let content: string;
      if (isTauri()) {
        if (!apiKey.trim()) {
          setSettingsOpen(true);
          setAgentError("请先在 AI 设置中填写 API Key");
          return;
        }
        content = await invoke<string>("generate_agent", {
          apiKey: apiKey.trim(),
          endpoint: endpoint.trim(),
          model: model.trim(),
          request: context,
        });
      } else {
        if (!auth.token) {
          setAgentError("请先登录账号后使用 AI 深度分析");
          return;
        }
        const result = await authApi.agentPlan(auth.token, context);
        if (!result.ok) {
          setAgentError(result.message);
          return;
        }
        content = result.data.content;
      }
      const proposal = validateAgentProposal(JSON.parse(content), context);
      if (!proposal) {
        // 全部动作都不适用于当前行程（越界、已打卡、时间冲突、超预算）。
        // 静默置空会让用户以为"点了没反应"，必须给一句能看懂的话。
        setAgentError("AI 给的调整都不适用于当前行程，请稍后重试或换个问法。");
        return;
      }
      setAgentProposal(proposal);
      setAgentNotice("AI 已生成提案，请逐项确认后执行。");
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : "";
      // Native errors are intentionally generic English strings so they do
      // not expose provider details. Keep the product surface in Chinese;
      // validation failures already contain a useful Chinese explanation.
      const message = /[\u4e00-\u9fff]/.test(rawMessage)
        ? rawMessage
        : "AI 管家暂时不可用，请检查网络、API Key 和额度后重试";
      setAgentError(message);
    } finally {
      setAgentBusy(false);
    }
  }
  function applyAgentAction(index: number) {
    if (!agentProposal) return;
    const action = agentProposal.actions[index];
    if (!action) return;
    const context = agentContext();
    const problem = validateAgentActionForTrip(trip, action, context.completed, context.budget, agentReminders);
    if (problem) { setAgentError(problem); return; }
    if (action.type === "add_todo") {
      setAgentReminders((previous) => previous.includes(action.text) ? previous : [...previous, action.text].slice(-20));
    } else {
      setTrip((previous) => {
        const days = previous.days.map((day) => ({ ...day, activities: day.activities.map((item) => ({ ...item })) }));
        const original = days[action.day].activities[action.index];
        days[action.day].activities[action.index] = action.type === "reschedule_activity" ? { ...original, time: action.time } : action.activity;
        return { ...previous, days };
      });
    }
    setAgentProposal((previous) => previous ? { ...previous, actions: previous.actions.filter((_, itemIndex) => itemIndex !== index) } : previous);
    setAgentNotice("已执行这项确认，其他提案仍需单独确认。");
  }
  function handleAgentAction(suggestion: TravelAgentSuggestion) {
    if (suggestion.action === "refresh-weather") {
      setAgentNotice("已发起天气刷新，行程管家会根据最新数据重新检查。");
      setWeatherRefreshTick((value) => value + 1);
      return;
    }
    if (suggestion.action === "focus-day" && suggestion.day !== undefined) {
      setActiveDay(Math.max(0, Math.min(suggestion.day, trip.days.length - 1)));
      setAgentNotice(`已定位到第 ${suggestion.day + 1} 天，请确认是否需要调整安排。`);
      return;
    }
    if (suggestion.action === "add-reminder" && suggestion.reminder) {
      setAgentReminders((previous) => previous.includes(suggestion.reminder!)
        ? previous
        : [...previous, suggestion.reminder!].slice(-20));
      setAgentNotice("已加入行前待办，是否完成由你确认。");
      setView("prep");
      return;
    }
    if (suggestion.action === "hotel-search") {
      void openLocationMap("amap", trip.destination, suggestion.query || `${trip.destination} 酒店`)
        .then(() => setAgentNotice("已打开住宿搜索，请自行核对位置、价格、取消政策和订单信息。"))
        .catch(() => setAgentNotice("暂时无法打开住宿搜索，请在安卓端安装地图应用或检查网络。"));
      return;
    }
    if (suggestion.action === "ticket-search") {
      void openExternal("https://www.12306.cn/index/")
        .then(() => setAgentNotice("已打开 12306 官方入口，请自行核对车次、证件和退改规则。"))
        .catch(() => setAgentNotice("暂时无法打开购票入口，请检查网络。"));
    }
  }
  function openBookingEntry(label: string, url: string) {
    void openExternal(url)
      .then(() => setAgentNotice(`已打开${label}，请在外部页面核对信息后自行下单。`))
      .catch(() => setAgentNotice(`暂时无法打开${label}，请检查网络。`));
  }
  function openHotelMapSearch() {
    void openLocationMap("amap", trip.destination, `${trip.destination} 酒店`)
      .then(() => setAgentNotice("已打开附近住宿搜索，请核对位置、价格、取消政策和订单信息。"))
      .catch(() => setAgentNotice("暂时无法打开住宿搜索，请安装地图 App 或检查网络。"));
  }
  const checkInDone = trip.days.reduce(
    (sum, day, dayIndex) =>
      sum +
      day.activities.filter(
        (_, index) => readCheckIn(checkIns, trip, dayIndex, index),
      ).length,
    0,
  );
  const checkInTotal = trip.days.reduce(
    (sum, day) => sum + day.activities.length,
    0,
  );
  function toggleCheckIn(dayIndex: number, index: number): void;
  function toggleCheckIn(key: string): void;
  function toggleCheckIn(dayOrKey: number | string, index?: number) {
    const key = typeof dayOrKey === "string"
      ? dayOrKey
      : activityStableKey(trip, dayOrKey, index ?? 0);
    setCheckIns((previous) => {
      const next = { ...previous };
      const legacyKeys = typeof dayOrKey === "number"
        ? [
            activityHistoricalStableKey(trip, dayOrKey, index ?? 0),
            activityLegacyStableKey(trip, dayOrKey, index ?? 0),
            activityKey(trip, dayOrKey, index ?? 0),
          ]
        : trip.days.flatMap((day, dayIndex) =>
          day.activities.map((_, activityIndex) =>
            (activityStableKey(trip, dayIndex, activityIndex) === key ||
              activityHistoricalStableKey(trip, dayIndex, activityIndex) === key)
              ? [
                    activityHistoricalStableKey(trip, dayIndex, activityIndex),
                    activityLegacyStableKey(trip, dayIndex, activityIndex),
                    activityKey(trip, dayIndex, activityIndex),
                  ]
                : [],
          ),
        ).flat();
      const matchedLegacy = legacyKeys.find((legacyKey) => next[legacyKey]);
      if (next[key] || matchedLegacy) {
        delete next[key];
        legacyKeys.forEach((legacyKey) => delete next[legacyKey]);
      } else {
        next[key] = { at: new Date().toISOString(), note: "" };
      }
      return next;
    });
  }
  function setCheckInNote(key: string, note: string) {
    const safeNote = note.slice(0, 2_000);
    setCheckIns((previous) => {
      const current = previous[key];
      if (current) return { ...previous, [key]: { ...current, note: safeNote } };
      for (let dayIndex = 0; dayIndex < trip.days.length; dayIndex += 1) {
        for (let index = 0; index < trip.days[dayIndex].activities.length; index += 1) {
          if (activityStableKey(trip, dayIndex, index) !== key &&
            activityHistoricalStableKey(trip, dayIndex, index) !== key) continue;
          const legacyKeys = [
            activityHistoricalStableKey(trip, dayIndex, index),
            activityLegacyStableKey(trip, dayIndex, index),
            activityKey(trip, dayIndex, index),
          ];
          const legacyKey = legacyKeys.find((candidate) => previous[candidate]);
          const legacy = legacyKey ? previous[legacyKey] : undefined;
          if (!legacyKey || !legacy) return previous;
          return { ...previous, [legacyKey]: { ...legacy, note: safeNote } };
        }
      }
      return previous;
    });
  }
  function closeTutorial(openSettings = false) {
    saveJson("route-tutorial-seen", true);
    setTutorialStep(null);
    if (openSettings) setSettingsOpen(true);
  }
  function showTutorial() {
    setSettingsOpen(false);
    setTutorialStep(0);
  }
  const provider = providers.find((item) => item.id === providerId) ?? primaryProvider;
  // 单人版只有主服务商，keyUrl 的兜底也必须指向它——写死 OpenAI 会让用户
  // 在只有 DeepSeek 的构建里被送到一个用不上的页面。
  const providerKeyPage = provider.keyUrl ?? primaryProvider.keyUrl ?? "";
  const apiKey = apiKeys[providerId] ?? "";
  function beginUpdateOperation() {
    if (updateOperationLock.current) return false;
    updateOperationLock.current = true;
    setUpdateBusy(true);
    return true;
  }
  function endUpdateOperation() {
    updateOperationLock.current = false;
    setUpdateBusy(false);
  }
  function saveAiSetting<T>(key: string, value: T) {
    try {
      if (isAndroidSecureStore() && key === "route-ai-keys") {
        scheduleAiKeysWrite(value as Partial<Record<ProviderId, string>>);
      }
      else if (key === "route-ai-keys") {
        // Non-Android builds intentionally keep API keys in memory only.
        // Android takes the secure-storage branch above.
        try { localStorage.removeItem("route-ai-keys"); } catch { /* best effort */ }
      }
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      setError("设置保存失败，请检查设备存储空间");
    }
  }
  function selectProvider(nextId: ProviderId) {
    const next = providers.find((item) => item.id === nextId) ?? defaultProvider;
    setProviderId(nextId);
    setEndpoint(next.endpoint);
    setModel(next.model);
    saveAiSetting("route-ai-provider", nextId);
    saveAiSetting("route-ai-endpoint", next.endpoint);
    saveAiSetting("route-ai-model", next.model);
  }
  async function installUpdate() {
    if (!availableUpdate) return;
    if (!beginUpdateOperation()) return;
    ++updateCheckVersion.current;
    setUpdateError("");
    try {
      await availableUpdate.downloadAndInstall();
      // The desktop updater may stage the package and return before the
      // process restarts. Clear the handle after a successful hand-off so a
      // second click cannot download/install the same release again.
      setAvailableUpdate(null);
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // Some desktop targets return after staging the update instead of
      // restarting immediately. Always release the UI lock in that case.
      endUpdateOperation();
    }
  }
  async function runUpdateCheck(options: { quiet?: boolean } = {}): Promise<UpdateCheckResult> {
    if (!beginUpdateOperation()) {
      return { supported: isTauri(), update: null, androidUpdate: null, error: "更新检查已在进行中" };
    }
    const version = ++updateCheckVersion.current;
    setUpdateError("");
    // A failed refresh must not leave an old release installable. Close the
    // desktop updater handle before discarding it; Android updates are plain
    // metadata and are cleared directly.
    if (availableUpdate) void availableUpdate.close().catch(() => {});
    setAvailableUpdate(null);
    setAndroidUpdate(null);
    try {
      if (!isTauri()) {
        const message = "当前运行环境不支持应用更新检查";
        if (!options.quiet) setError(message);
        return { supported: false, update: null, androidUpdate: null, error: message };
      }
      if (/Android/i.test(navigator.userAgent)) {
        const update = await invoke<AndroidUpdate | null>("plugin:android-updater|check");
        setAndroidUpdate(update);
        if (!options.quiet) setError(update ? `发现新版本 v${update.version}，请在页面顶部下载安装` : "当前已是最新版本");
        return { supported: true, update: null, androidUpdate: update };
      } else {
        const update = await check();
        setAvailableUpdate(update);
        if (!options.quiet) setError(update ? `发现新版本 v${update.version}，请在页面顶部下载安装` : "当前已是最新版本");
        if (!update) setUpdateError("");
        return { supported: true, update, androidUpdate: null };
      }
    } catch (reason) {
      const message = `检查更新失败：${reason instanceof Error ? reason.message : String(reason)}`;
      if (!options.quiet) setError(message);
      return { supported: isTauri(), update: null, androidUpdate: null, error: message };
    } finally {
      // A newer operation owns the lock now. Stale checks must only discard
      // their result; clearing the shared lock here would allow a second
      // download/install to overlap the active operation.
      if (version === updateCheckVersion.current) endUpdateOperation();
    }
  }
  async function checkForUpdates() {
    await runUpdateCheck();
  }
  async function runSelfCheck() {
    if (selfCheckOperationLock.current) return;
    selfCheckOperationLock.current = true;
    setSelfCheckBusy(true);
    setSelfCheckItems([]);
    const items: SelfCheckItem[] = [];
    const checkedTrip = tripSchema.safeParse(trip);
    items.push(checkedTrip.success
      ? { label: "行程数据", status: "ok", detail: `${trip.days.length} 天、${trip.days.reduce((sum, day) => sum + day.activities.length, 0)} 个安排，结构校验通过` }
      : { label: "行程数据", status: "error", detail: checkedTrip.error.issues[0]?.message ?? "行程数据格式异常" });
    const checkedInput = plannerInputSchema.safeParse(input);
    items.push(checkedInput.success
      ? { label: "规划条件", status: "ok", detail: `${input.destination} · ${input.days} 天 · ${input.travelers} 人` }
      : { label: "规划条件", status: "error", detail: checkedInput.error.issues[0]?.message ?? "规划条件格式异常" });
    items.push({
      label: "应用版本",
      status: APP_VERSION === "0.0.0" ? "warn" : "ok",
      detail: APP_VERSION === "0.0.0" ? "未读取到构建版本" : `当前版本 v${APP_VERSION}`,
    });
    try {
      const key = `route-self-check:${Date.now()}`;
      const marker = JSON.stringify({ ok: true, at: Date.now() });
      localStorage.setItem(key, marker);
      const storedMarker = localStorage.getItem(key);
      localStorage.removeItem(key);
      items.push(storedMarker === marker
        ? { label: "本机存储", status: "ok", detail: "读写测试通过，未修改行程数据" }
        : { label: "本机存储", status: "error", detail: "读回内容与写入内容不一致" });
    } catch {
      items.push({ label: "本机存储", status: "error", detail: "读写测试失败，请检查设备存储空间" });
    }
    if (nativeAiSettings && isAndroidSecureStore()) {
      if (!aiKeysReady) {
        items.push({ label: "Android 安全存储", status: "warn", detail: "安全存储仍在恢复，请稍后再次自检" });
      } else {
        const secure = await readSecureEntry<Partial<Record<ProviderId, string>>>("route-ai-keys");
        if (!secure.ok) {
          items.push({ label: "Android 安全存储", status: "error", detail: "无法读取 Keystore，请检查设备锁屏状态和存储空间" });
        } else {
          items.push({
            label: "Android 安全存储",
            status: "ok",
            detail: secure.found ? "Keystore 可读，AI Key 不会写入明文存储" : "Keystore 可用，当前尚未保存 AI Key",
          });
        }
      }
    } else if (nativeAiSettings) {
      items.push({
        label: "AI Key",
        status: "warn",
        detail: apiKey.trim() ? "已填写，仅保存在本次桌面运行内存中" : "尚未填写，生成攻略前需要配置",
      });
    } else {
      items.push({ label: "AI 服务", status: "warn", detail: "网页端由账号服务代理，请在账号页检查服务状态" });
    }
    items.push({
      label: "网络连接",
      status: online ? "ok" : "warn",
      detail: online ? "当前在线，可检查更新和刷新天气" : "当前离线，本机行程功能仍可使用",
    });
    const updateResult = await runUpdateCheck({ quiet: true });
    if (!updateResult.supported) {
      items.push({ label: "应用更新", status: "warn", detail: updateResult.error ?? "当前环境不支持更新检查" });
    } else if (updateResult.error) {
      items.push({ label: "应用更新", status: "warn", detail: updateResult.error });
    } else if (updateResult.update || updateResult.androidUpdate) {
      const version = updateResult.update?.version ?? updateResult.androidUpdate?.version ?? "新版本";
      items.push({ label: "应用更新", status: "warn", detail: `发现 v${version}，可在本页或顶部更新` });
    } else {
      items.push({ label: "应用更新", status: "ok", detail: "当前已是最新版本" });
    }
    setSelfCheckItems(items);
    setSelfCheckAt(new Date().toLocaleString("zh-CN", { hour12: false }));
    selfCheckOperationLock.current = false;
    setSelfCheckBusy(false);
  }
  async function installAndroidUpdate() {
    if (!androidUpdate) return;
    if (!beginUpdateOperation()) return;
    ++updateCheckVersion.current;
    setUpdateError("");
    try {
      // The native command parses InstallArgs directly; do not wrap the
      // payload in a `release` property or Tauri will reject it before the
      // download starts.
      await invoke("plugin:android-updater|install", androidUpdate);
      // The native plugin resolves once the system installer has accepted the
      // APK. Remove the actionable banner immediately; keeping it visible
      // would allow duplicate downloads while the user is confirming install.
      setAndroidUpdate(null);
      setError("已打开系统安装器，请确认安装途迹更新");
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      endUpdateOperation();
    }
  }
  async function requestTrip(request: PlannerInput) {
    if (!isTauri()) {
      if (!auth.token) throw new Error("请先登录账号");
      const result = await authApi.generateTrip(auth.token, request);
      if (!result.ok) throw new Error(result.message);
      return parseTripContent(result.data.content, request);
    }
    const raw = await invoke<string>("generate_trip", {
      apiKey: apiKey.trim(),
      endpoint: endpoint.trim(),
      model: model.trim(),
      request,
    });
    return parseTripContent(raw, request);
  }

  async function generate() {
    setError("");
    setBudgetNotice("");
    if (!aiKeysReady) {
      setError("正在恢复 AI 设置，请稍候再试");
      return;
    }
    if (!input.destination.trim()) {
      setError("请先填写目的地");
      return;
    }
    if (isTauri() && !apiKey.trim()) {
      setSettingsOpen(true);
      setError("请在 AI 设置中填写 API Key");
      return;
    }
    setBusy(true);
    try {
      const first = await requestTrip(input);
      const firstStatus = budgetStatus(
        first,
        input.budget,
        input.travelers,
        input.days,
      );
      if (!firstStatus.over) {
        snapshotBeforeReplace("AI 生成行程");
        setTrip({ ...first, sample: false });
        setActiveDay(0);
        setBudgetNotice(budgetPlanAdvice(firstStatus, input));
        play("success");
        return;
      }
      // 超预算：带上差额与目标额度重排一次，避免直接交付一个不可能的方案。
      setBudgetNotice(
        `首版合计 ${money(firstStatus.total)}，超出预算 ${money(Math.abs(firstStatus.remaining))}，正在按预算重排…`,
      );
      let second: Trip | null = null;
      try {
        second = await requestTrip({
          ...input,
          notes: budgetFixNote(firstStatus, input),
        });
      } catch {
        second = null;
      }
      const picked = pickWithinBudget(first, second, input.budget);
      const finalStatus = budgetStatus(
        picked.trip,
        input.budget,
        input.travelers,
        input.days,
      );
      snapshotBeforeReplace("AI 按预算重排");
      setTrip({ ...picked.trip, sample: false });
      setActiveDay(0);
      play(picked.stillOver ? "error" : "success");
      setBudgetNotice(
        picked.stillOver
          ? `重排后合计 ${money(finalStatus.total)}，仍超预算 ${money(Math.abs(finalStatus.remaining))}。${budgetPlanAdvice(finalStatus, input)}以 ${input.travelers} 人 ${input.days} 天计算，人均每天约 ${money(finalStatus.perPersonPerDay)}。`
          : `已按预算重排：合计 ${money(finalStatus.total)}，占预算 ${finalStatus.percent}%，人均 ${money(finalStatus.average)}。${budgetPlanAdvice(finalStatus, input)}`,
      );
    } catch (reason) {
      play("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  function updateActivity(dayIndex: number, index: number, activity: Activity) {
    if (index < 0 && (trip.days[dayIndex]?.activities.length ?? 0) >= MAX_ACTIVITIES_PER_DAY) {
      setError(`每天最多添加 ${MAX_ACTIVITIES_PER_DAY} 项安排，请先删除不需要的项目`);
      setEditing(null);
      return;
    }
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
  async function exportJson() {
    const packingKey = `route-packing:${tripNamespace(trip)}`;
    const packing = loadStored<PackingItem[]>(packingKey, [], sanitizePackingItems);
    const payload = {
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      trip,
      input,
      weather,
      expenses,
      checkIns,
      prepState,
      packing,
    };
    try {
      await downloadText(
        `${trip.destination || "旅行"}-途迹备份.json`,
        JSON.stringify(payload, null, 2),
        "application/json;charset=utf-8",
      );
      setError("已生成行程备份 JSON；如需换机恢复，请用「设置 → 数据备份与恢复」导出 .routebackup");
    } catch (reason) {
      setError(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  async function exportPlacesCsv() {
    const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [
      ["天数", "时间", "类型", "名称", "地点", "停留分钟", "预计费用", "备注"],
      ...trip.days.flatMap((item, dayIndex) =>
        item.activities.map((activity) => [
          `第${dayIndex + 1}天`,
          activity.time,
          activity.type,
          activity.title,
          activity.location || trip.destination,
          activity.durationMinutes,
          activity.estimatedCost,
          activity.detail,
        ]),
      ),
    ];
    try {
      await downloadText(
        `${trip.destination || "旅行"}-地点清单.csv`,
        `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
        "text/csv;charset=utf-8",
      );
      setError("地点清单 CSV 已生成");
    } catch (reason) {
      setError(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  async function exportCalendar() {
    const escapeIcs = (value: string) => value.replace(/[\\;,]/g, (match) => `\\${match}`).replace(/\r?\n/g, "\\n");
    const toUtcStamp = (date: string, time: string) => {
      const parsed = new Date(`${date}T${/^\d{2}:\d{2}$/.test(time) ? time : "09:00"}:00`);
      return Number.isNaN(parsed.getTime())
        ? `${date.replace(/-/g, "")}T090000`
        : parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    };
    const events = trip.days.flatMap((dayItem, dayIndex) =>
      dayItem.activities.map((activity, activityIndex) => {
        const start = toUtcStamp(dayItem.date, activity.time);
        const startDate = new Date(`${dayItem.date}T${/^\d{2}:\d{2}$/.test(activity.time) ? activity.time : "09:00"}:00`);
        const endDate = new Date(startDate.getTime() + activity.durationMinutes * 60_000);
        const end = Number.isNaN(endDate.getTime())
          ? start
          : endDate.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        return [
          "BEGIN:VEVENT",
          `UID:route-${dayIndex}-${activityIndex}-${start}@luyou-planner`,
          `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
          `DTSTART:${start}`,
          `DTEND:${end}`,
          `SUMMARY:${escapeIcs(activity.title)}`,
          `LOCATION:${escapeIcs(activity.location || trip.destination)}`,
          `DESCRIPTION:${escapeIcs(activity.detail || `${dayItem.theme} · 预计费用 ¥${activity.estimatedCost}`)}`,
          "END:VEVENT",
        ].join("\r\n");
      }),
    );
    try {
      await downloadText(
        `${trip.destination || "旅行"}-行程日历.ics`,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Luyou Route//Trip Planner//CN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`,
        "text/calendar;charset=utf-8",
      );
      setError("行程日历 .ics 已生成，可导入系统日历");
    } catch (reason) {
      setError(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  /**
   * 恢复核心：整包校验 → 先存快照 → 全量写入 → 任一失败即回滚。
   *
   * 两条入口共用它：
   *  - 导入 .routebackup 文件
   *  - 回滚本机快照
   *
   * 返回空串表示成功；任何失败都返回可读原因，并且**保证**本机数据回到调用前状态。
   */
  async function restoreFromData(
    payload: {
      trip?: unknown;
      input?: unknown;
      weather?: unknown;
      expenses?: unknown;
      checkIns?: unknown;
      prepState?: unknown;
      packing?: unknown;
    },
    origin: string,
  ): Promise<string> {
    try {
      const parsedTrip = tripSchema.safeParse(payload.trip);
      if (!parsedTrip.success) return "行程结构无效，未做任何改动";

      let parsedInput: PlannerInput | undefined;
      if (payload.input !== undefined) {
        if (!payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) {
          return "备份中的规划条件无效";
        }
        const result = plannerInputSchema.safeParse({ ...input, ...(payload.input as Partial<PlannerInput>) });
        if (!result.success) return "备份中的规划条件无效";
        parsedInput = result.data;
      }

      const importedWeather = payload.weather === undefined
        ? undefined
        : Array.isArray(payload.weather) && payload.weather.length <= 100 && payload.weather.every(isBackupWeather)
          ? (payload.weather as Weather[])
          : null;
      if (importedWeather === null) return "备份中的天气数据无效";

      const importedExpenses = payload.expenses === undefined
        ? undefined
        : Array.isArray(payload.expenses) && payload.expenses.length <= 1_000 && payload.expenses.every(isBackupExpense) &&
          new Set(payload.expenses.map((item) => (item as Expense).id)).size === payload.expenses.length &&
          sanitizeExpenses(payload.expenses as Expense[])?.length === payload.expenses.length
          ? sanitizeExpenses(payload.expenses as Expense[])!
          : null;
      if (importedExpenses === null) return "备份中的记账数据无效";

      const importedCheckIns = payload.checkIns === undefined
        ? undefined
        : isBackupCheckIns(payload.checkIns) &&
          Object.keys(sanitizeCheckIns(payload.checkIns) ?? {}).length === Object.keys(payload.checkIns).length
          ? sanitizeCheckIns(payload.checkIns)!
          : null;
      if (importedCheckIns === null) return "备份中的打卡数据无效";

      const importedPrepState = payload.prepState === undefined
        ? undefined
        : isBackupPrepState(payload.prepState) && sanitizePrepState(payload.prepState) &&
          Object.keys(sanitizePrepState(payload.prepState)!).length === Object.keys(payload.prepState).length
          ? sanitizePrepState(payload.prepState)!
          : null;
      if (importedPrepState === null) return "备份中的待办数据无效";

      const importedPacking = payload.packing === undefined
        ? undefined
        : isBackupPackingItems(payload.packing) && sanitizePackingItems(payload.packing)?.length === payload.packing.length
          ? sanitizePackingItems(payload.packing)!
          : null;
      if (importedPacking === null) return "备份中的打包清单无效";

      // 全部校验通过后，才允许写任何东西。
      const currentPacking = loadStored<PackingItem[]>(`route-packing:${namespace}`, [], sanitizePackingItems);
      writeSnapshotFor("恢复前自动留档", {
        trip,
        input,
        weather,
        expenses,
        checkIns,
        prepState,
        packing: currentPacking,
      });

      const importedNamespace = tripNamespace(parsedTrip.data);
      const importedKeys = {
        expenses: `route-ledger:${importedNamespace}`,
        checkIns: `route-checkin:${importedNamespace}`,
        prepState: `route-prep:${importedNamespace}`,
        packing: `route-packing:${importedNamespace}`,
      };
      const previousRaw = new globalThis.Map<string, string | null>();
      const touchedKeys: string[] = [];
      try {
        const persistImported = (key: string, value: unknown, message: string) => {
          previousRaw.set(key, localStorage.getItem(key));
          // 先登记再写：某些存储实现会「写入成功但随后抛错」，回滚必须覆盖它。
          touchedKeys.push(key);
          if (!saveJson(key, value)) throw new Error(message);
        };
        persistImported("route-trip", parsedTrip.data, "设备存储空间不足，无法导入行程");
        if (parsedInput !== undefined) {
          persistImported("route-input", parsedInput, "设备存储空间不足，无法导入规划条件");
        }
        if (importedExpenses !== undefined) {
          persistImported(importedKeys.expenses, importedExpenses, "设备存储空间不足，无法导入记账数据");
        }
        if (importedCheckIns !== undefined) {
          persistImported(importedKeys.checkIns, importedCheckIns, "设备存储空间不足，无法导入打卡数据");
        }
        if (importedPrepState !== undefined) {
          persistImported(importedKeys.prepState, importedPrepState, "设备存储空间不足，无法导入待办数据");
        }
        if (importedPacking !== undefined) {
          persistImported(importedKeys.packing, importedPacking, "设备存储空间不足，无法导入打包清单");
        }
      } catch (reason) {
        // 部分写入后失败：把每个被碰过的键还原，保证「要么全成功，要么全不变」。
        for (const key of touchedKeys) {
          const raw = previousRaw.get(key);
          try {
            if (raw === null || raw === undefined) localStorage.removeItem(key);
            else localStorage.setItem(key, raw);
          } catch { /* 保留原始错误 */ }
        }
        throw reason;
      }

      if (importedNamespace === namespace) {
        if (importedExpenses !== undefined) setExpenses(importedExpenses);
        if (importedCheckIns !== undefined) setCheckIns(importedCheckIns);
        if (importedPrepState !== undefined) setPrepState(importedPrepState);
        if (importedPacking !== undefined) setPackingRevision((value) => value + 1);
      }
      let importedWeatherSaved = true;
      // 行程变短后旧的天索引不能保留：渲染会被 clamp，但编辑仍指向那个索引。
      setActiveDay(0);
      setEditing(null);
      setTrip(parsedTrip.data);
      if (parsedInput) setInput(parsedInput);
      if (importedWeather !== undefined) {
        // 让导入的天气快照被当成新行程的临时缓存，而不是上一个行程的过期数据。
        const importedDates = parsedTrip.data.days.map((item) => item.date).join(",");
        importedWeatherSaved = saveWeatherBackup(
          parsedTrip.data.destination,
          parsedTrip.data.days.map((item) => item.date),
          importedWeather,
        );
        weatherQueryKey.current = `${parsedTrip.data.destination.trim()}|${importedDates}`;
        setWeather(importedWeather);
        setCurrentWeather(undefined);
        setWeatherStatus("已恢复备份天气，正在刷新实时预报");
        setWeatherUpdatedAt("");
        setWeatherStale(true);
      }
      setError(importedWeatherSaved
        ? `${origin} 已完成恢复`
        : `${origin} 已恢复，但天气快照未能保存；联网后会重新获取`);
      return "";
    } catch (reason) {
      return `${origin} 恢复失败：${reason instanceof Error ? reason.message : "文件格式不正确"}`;
    }
  }

  /** 以旧 .json 备份格式读取并转为统一结构，兼容 0.3.9 之前导出的文件。 */
  async function importBackup(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("备份文件不能超过 5 MB");
      const text = await file.text();
      const raw = JSON.parse(text) as {
        schemaVersion?: unknown;
        trip?: unknown;
        input?: unknown;
        weather?: unknown;
        expenses?: unknown;
        checkIns?: unknown;
        prepState?: unknown;
        packing?: unknown;
      };
      // .routebackup（含加密包）优先；解析器会自行校验 checksum / AEAD。
      if (raw && typeof raw === "object" && (raw as { format?: unknown }).format === BACKUP_FORMAT_ID) {
        setError("请用「设置 → 数据备份与恢复」导入 .routebackup 文件；加密备份需要在那里输入口令");
        return;
      }
      if (raw.schemaVersion !== undefined &&
        (typeof raw.schemaVersion !== "number" || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1 || raw.schemaVersion > 3)) {
        throw new Error("备份版本不受当前应用支持");
      }
      const tripParsed = tripSchema.safeParse(raw.trip);
      if (!tripParsed.success) throw new Error("行程结构无效");
      const failure = await restoreFromData(raw, "行程备份");
      if (failure) throw new Error(failure.replace(/^行程备份 恢复失败：/, ""));
    } catch (reason) {
      setError(`导入失败：${reason instanceof Error ? reason.message : "文件格式不正确"}`);
    }
  }

  /**
   * 写一个滚动快照。存储写满时**不静默**：快照是误操作的最后一道保护，
   * 它失败必须让用户知道，否则下一次覆盖就不可逆了。
   */
  function writeSnapshotFor(label: string, data: {
    trip: Trip;
    input: PlannerInput;
    weather: Weather[];
    expenses: Expense[];
    checkIns: CheckInMap;
    prepState: Record<string, boolean>;
    packing: PackingItem[];
  }) {
    const id = newSnapshotId();
    const createdAt = new Date().toISOString();
    const counts = [
      { label: "行程天数", count: data.trip.days.length },
      { label: "活动条目", count: data.trip.days.reduce((sum, day) => sum + day.activities.length, 0) },
      { label: "记账明细", count: data.expenses.length },
      { label: "打卡记录", count: Object.keys(data.checkIns).length },
      { label: "打包清单", count: data.packing.length },
    ];
    const ok = writeSnapshot(
      {
        id,
        createdAt,
        appVersion: APP_VERSION,
        sections: [...ALL_SECTIONS],
        counts,
      },
      {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        createdAt,
        sections: [...ALL_SECTIONS],
        data: {
          trip: data.trip,
          input: data.input,
          weather: data.weather,
          expenses: data.expenses,
          checkIns: data.checkIns,
          prepState: data.prepState,
          packing: data.packing,
        },
      },
    );
    if (!ok) {
      setError(`${label}的快照未能保存（设备存储可能已满）。建议先导出备份再继续。`);
    }
    return ok;
  }

  /**
   * 「重要修改」前的自动留档。
   *
   * 触发点：AI 生成行程、AI 按预算重排、导入/快照恢复（后者在 restoreFromData 内）。
   * 不覆盖手动微调（编辑单个活动/记账）——那类改动频次高，会把 5 个名额迅速刷掉，
   * 反而丢掉真正有价值的旧版本。
   */
  function snapshotBeforeReplace(label: string) {
    if (trip.sample) return; // 示例行程没有留档价值，别挤掉真实数据的名额
    writeSnapshotFor(label, {
      trip,
      input,
      weather,
      expenses,
      checkIns,
      prepState,
      packing: loadStored<PackingItem[]>(`route-packing:${namespace}`, [], sanitizePackingItems),
    });
  }

  function collectBackupSource() {
    const packingKey = `route-packing:${namespace}`;
    return {
      trip,
      plannerInput: input,
      weather,
      expenses,
      checkIns,
      prepState,
      packing: loadStored<PackingItem[]>(packingKey, [], sanitizePackingItems),
    };
  }

  const dayWeather = weather.find((item) => item.date === day?.date);
  const mapActivities = trip.days.flatMap((item) => item.activities);
  const mapLocations = mapActivities
    .map((item) => item.location || item.title)
    .filter((location, index, list) => location && list.indexOf(location) === index);
  const lodgingCount = mapActivities.filter((item) =>
    /住宿|酒店|民宿|客栈|旅馆/.test(`${item.type}${item.title}${item.location}`),
  ).length;
  const isAndroidApp = isTauri() && /Android/i.test(navigator.userAgent);
  const installedMapLabels = mapAppLabels(installedMapApps);
  const refreshMapApps = () => {
    if (!isAndroidApp) {
      setInstalledMapApps([]);
      setMapAppError(null);
      return;
    }
    setMapAppError(null);
    invoke<{ packages: string[] }>("plugin:map-launcher|map_apps")
      .then((result) => setInstalledMapApps(result?.packages ?? []))
      .catch((error) => {
        // 原生插件不可用时不影响跳转，仅记录原因，便于在真机上定位问题。
        setInstalledMapApps([]);
        setMapAppError(String(error));
      });
  };
  useEffect(() => {
    refreshMapApps();
  }, []);
  const destinationSuggestions = useMemo(() => {
    const query = input.destination.trim();
    if (!query) return [];
    return destinationOptions
      .filter(
        (option) => option.name.includes(query) || option.region.includes(query),
      )
      .sort((a, b) => {
        const aRank = a.name.startsWith(query) ? 0 : a.name.includes(query) ? 1 : 2;
        const bRank = b.name.startsWith(query) ? 0 : b.name.includes(query) ? 1 : 2;
        return aRank - bRank || a.name.localeCompare(b.name, "zh-CN");
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
    <>
      {(!auth.ready || !startupMinimumReady) && (
        <AppSplash secureReady={auth.ready} minimumReady={startupMinimumReady} />
      )}
      {locked ? <LockScreen onUnlock={() => setLocked(false)} /> : null}
      <div className={`app-shell${uiPreferences.motionEnabled ? " motion-on" : " motion-off"}`}>
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
        {visibleViewTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={`nav-item nav-button${displayView === tab.id ? " active" : ""}`}
              onClick={() => {
                play("click");
                if (requiresAccount() && tab.id !== "account" && !auth.user) {
                  play("error");
                  setError("请先登录账号后使用行程功能");
                  setView("account");
                  return;
                }
                setView(tab.id);
              }}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
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
          界面设置
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
            className="text-button export-button"
            title="下载行程 JSON"
            aria-label="下载行程 JSON"
            onClick={exportJson}
          >
            <Download size={16} />
            JSON
          </button>
          <button
            className="text-button export-button"
            title="下载地点清单 CSV"
            aria-label="下载地点清单 CSV"
            onClick={exportPlacesCsv}
          >
            <Download size={16} />
            CSV
          </button>
          <button
            className="text-button export-button"
            title="导入系统日历"
            aria-label="导入系统日历"
            onClick={exportCalendar}
          >
            <CalendarDays size={16} />
            日历
          </button>
          <label className="text-button export-button import-button" title="导入行程备份">
            <Download size={16} />
            导入
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importBackup(file);
                event.currentTarget.value = "";
              }}
              hidden
            />
          </label>
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
            AI 设置{apiKey ? (aiKeysPersisted ? " · 已保存" : " · 已填写") : ""}
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
        {androidUpdate && (
          <div className="update-banner" role="status">
            <div>
              <strong>发现新版本 v{androidUpdate.version}</strong>
              <span>将下载 APK 并打开系统安装器，确认后完成更新。</span>
              {updateError && <small>{updateError}</small>}
            </div>
            <button onClick={installAndroidUpdate} disabled={updateBusy}>
              {updateBusy ? "正在下载..." : "下载并安装"}
            </button>
          </div>
        )}
        <nav className="feature-tabs" aria-label="功能导航">
          {visibleViewTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={displayView === tab.id ? "active" : ""}
                aria-current={displayView === tab.id}
                onClick={() => {
                  if (requiresAccount() && tab.id !== "account" && !auth.user) {
                    setError("请先登录账号后使用行程功能");
                    setView("account");
                    return;
                  }
                  setView(tab.id);
                  play("switch");
                }}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        {!online && (
          <div className="offline-banner" role="status">
            <WifiOff size={15} />
            当前离线：行程、打包清单、记账与打卡都在本机，可正常使用；AI 生成与天气需要联网。
          </div>
        )}
        {error && (
          <div className="error-message app-global-error" role="alert">
            {error}
          </div>
        )}
        {auth.storageError && displayView !== "account" && (
          <div className="error-message app-global-error" role="alert">
            {auth.storageError}
          </div>
        )}
        {displayView === "trip" ? (
        <div className="workspace-body">
          <section className="planner-panel" aria-label="规划条件">
            <div className="panel-kicker">NEW JOURNEY</div>
            <h1>规划下一程</h1>
            <p className="panel-subtitle">告诉我你的出行安排</p>
            <button type="button" className="winter-preset" onClick={applyWinterBreakPreset}>
              <Sparkles size={14} />
              寒假和同学玩 5 天
              <span>快速套用，可再修改日期和预算</span>
            </button>
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
                    max="10000000"
                    step="100"
                    value={input.budget}
                    onChange={(event) =>
                      change(
                        "budget",
                        Number.isFinite(Number(event.target.value))
                          ? Math.max(0, Number(event.target.value))
                          : 0,
                      )
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
              <div className="trip-heading-actions">
                <button
                  className="refresh-button"
                  title="重新生成行程"
                  onClick={generate}
                  disabled={busy}
                >
                  <RefreshCw size={17} />
                  <span>重新生成</span>
                </button>
                <button
                  className="map-button"
                  title="用首末两点在地图里规划路线"
                  onClick={() => openTripRoute("amap", trip)}
                  disabled={tripRoutePoints(trip).length < 2}
                >
                  <Map size={16} />
                  <span>高德总览</span>
                </button>
              </div>
            </div>
            {budget.over && <HealthCard issues={issues} tone="alert" />}
            {budgetNotice && (
              <div className="budget-notice" role="status">
                {budgetNotice}
              </div>
            )}
            <TravelAgentPanel
              suggestions={agentSuggestions}
              notice={agentNotice}
              onAction={handleAgentAction}
              onAskAi={askAgentAi}
              onApplyAction={applyAgentAction}
              onDismiss={() => setAgentProposal(null)}
              proposal={agentProposal}
              busy={agentBusy}
              error={agentError}
            />
            <BookingPanel
              destination={trip.destination}
              startDate={trip.days[0]?.date || input.startDate}
              days={trip.days.length}
              travelers={input.travelers}
              onOpenRail={() => openBookingEntry("12306 火车票入口", RAIL_BOOKING_URL)}
              onOpenFlight={() => openBookingEntry("机票搜索入口", FLIGHT_BOOKING_URL)}
              onOpenHotel={() => openBookingEntry("酒店预订入口", HOTEL_BOOKING_URL)}
              onOpenHotelMap={openHotelMapSearch}
            />
            <div className="summary-strip">
              <div>
                <CalendarDays size={18} />
                <span>
                  <b>{trip.days.length} 天</b>
                  <small>{shortDate(trip.days[0]?.date || "")} 出发</small>
                </span>
              </div>
              <div className={budget.over ? "danger" : ""}>
                <Wallet size={18} />
                <span>
                  <b>{money(total)}</b>
                  <small>
                    全员合计 · 人均 {money(perPerson)}
                  </small>
                  {budget.over && (
                    <small className="over-budget">
                      超预算 {money(Math.abs(budget.remaining))}（已用 {budget.percent}%）
                    </small>
                  )}
                </span>
              </div>
              <div>
                <CloudSun size={18} />
                <span>
                  <b>{dayWeather?.label || "天气"}</b>
                  <small>{weatherStatus || "实时天气查询中"}</small>
                </span>
              </div>
              <div>
                <Megaphone size={18} />
                <span>
                  <b>{countdown.label}</b>
                  <small>
                    已打卡 {checkInDone}/{checkInTotal} 项
                  </small>
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
            {mapLocations.length > 0 && (
              <section className="map-overview" aria-label="地图总览">
                <div className="map-overview-copy">
                  <div className="map-overview-icon"><Map size={17} /></div>
                  <div>
                    <strong>一键导入地图</strong>
                    <p>
                      已整理 {mapLocations.length} 个地点
                      {lodgingCount > 0 ? `，包含 ${lodgingCount} 处住宿` : ""}
                    </p>
                  </div>
                </div>
                <div className="map-overview-points" aria-label="行程地点">
                  {mapActivities.slice(0, 5).map((item, index) => (
                    <span key={`${item.title}-${index}`} className={/住宿|酒店|民宿|客栈|旅馆/.test(`${item.type}${item.title}`) ? "lodging" : ""}>
                      {item.location || item.title}
                    </span>
                  ))}
                  {mapLocations.length > 5 && <span>+{mapLocations.length - 5} 个地点</span>}
                </div>
                <div className="map-overview-actions">
                  {mapProviderOrder.map((provider) => (
                    <button
                      key={provider}
                      className={`map-overview-action ${provider}`}
                      onClick={() => openTripRoute(provider, trip)}
                    >
                      {mapApps[provider].label} <ExternalLink size={14} />
                    </button>
                  ))}
                </div>
                <p className="map-app-status">
                  {installedMapApps === null
                    ? "正在检测本机地图应用…"
                    : installedMapLabels
                      ? `已检测到：${installedMapLabels}，点击将直接打开对应 App`
                      : mapAppError
                        ? `检测失败（${mapAppError}），点击将使用浏览器打开`
                        : "未检测到地图应用，点击将使用浏览器打开"}
                  {isAndroidApp && (
                    <button className="map-app-refresh" onClick={refreshMapApps}>
                      重新检测
                    </button>
                  )}
                </p>
              </section>
            )}
            {!budget.over && <HealthCard issues={issues} />}
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
                    当日估算 <strong>{money(dayCost(day))}</strong>
                    {input.travelers > 1 && (
                      <small>人均 {money(dayCost(day) / input.travelers)}</small>
                    )}
                  </div>
                </div>
                {(dayWeather || currentWeather) && (
                  <div className="weather-line">
                    <CloudSun size={17} />
                    {dayWeather?.summary || `${currentWeather?.label || "实时天气"} · ${currentWeather?.temperature ?? "--"}°C`}
                    <span>{currentWeather ? `实时 · ${liveAdvice}` : "Open-Meteo 预报"}</span>
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
                          {mapProviderOrder.map((provider) => (
                            <button
                              key={provider}
                              onClick={() =>
                                openLocationMap(
                                  provider,
                                  trip.destination,
                                  item.location,
                                )
                              }
                            >
                              {mapApps[provider].short} <ExternalLink size={13} />
                            </button>
                          ))}
                        </div>
                        <div className="activity-tools">
                          <button
                            className={
                              readCheckIn(checkIns, trip, activeDay, index)
                                ? "checked"
                                : ""
                            }
                            title="标记为已到访"
                            onClick={() =>
                              toggleCheckIn(activeDay, index)
                            }
                          >
                            <Check size={15} />
                            {readCheckIn(checkIns, trip, activeDay, index)
                              ? "已打卡"
                              : "打卡"}
                          </button>
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
                  disabled={day.activities.length >= MAX_ACTIVITIES_PER_DAY}
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
                  {day.activities.length >= MAX_ACTIVITIES_PER_DAY
                    ? `已达 ${MAX_ACTIVITIES_PER_DAY} 项上限`
                    : "添加安排"}
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
            <ShareCard
              trip={trip}
              input={input}
              weather={weather}
              expenses={expenses}
              checkIns={checkIns}
            />
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
        ) : (
          <div className="feature-scroll">
            {displayView === "packing" && (
              <PackingView trip={trip} input={input} weather={weather} refreshToken={packingRevision} />
            )}
            {displayView === "ledger" && (
              <LedgerView
                trip={trip}
                input={input}
                weather={weather}
                expenses={expenses}
                setExpenses={setExpenses}
              />
            )}
            {displayView === "checkin" && (
              <CheckInView
                trip={trip}
                checkIns={checkIns}
                onToggle={toggleCheckIn}
                onNote={setCheckInNote}
              />
            )}
            {displayView === "prep" && (
              <PrepView
                countdown={countdown}
                advisories={advisories}
                weatherStatus={weatherStatus}
                weatherUpdatedAt={weatherUpdatedAt}
                weatherStale={weatherStale}
                weatherLoading={weatherLoading}
                onRefreshWeather={() => setWeatherRefreshTick((value) => value + 1)}
                todos={prepState}
                onToggleTodo={(id) =>
                  setPrepState((previous) => ({
                    ...previous,
                    [id]: !previous[id],
                  }))
                }
                agentReminders={agentReminders}
                onToggleAgentReminder={(text) => {
                  const key = `agent:${text}`;
                  setPrepState((previous) => ({
                    ...previous,
                    [key]: !previous[key],
                  }));
                }}
              />
            )}
                {displayView === "account" && (
              <AccountView
                user={auth.user}
                ready={auth.ready}
                onLoggedIn={auth.adopt}
                onLogout={auth.logout}
                onCheckUpdate={checkForUpdates}
                storageError={auth.storageError}
              />
            )}
          </div>
        )}
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
                <p>
                  {MULTI_PROVIDER_ENABLED
                    ? "AI 生成攻略需要你选择一家服务商并准备对应的 API Key。支持 OpenAI、DeepSeek、智谱 AI、通义千问、Moonshot/Kimi 和 SiliconFlow。"
                    : `AI 生成攻略和 AI 管家深度分析需要一份 ${provider.name} 的 API Key。行程、记账、清单、打卡、提醒不依赖网络。`}
                </p>
                {providerKeyPage ? (
                  <button className="tutorial-link" onClick={() => openExternal(providerKeyPage)}>
                    打开 {provider.name} 的 API Key 页面 <ExternalLink size={15} />
                  </button>
                ) : null}
                <p className="tutorial-note">
                  {MULTI_PROVIDER_ENABLED
                    ? "API 使用可能需要单独开通付费或充值；ChatGPT 订阅通常不包含 API 额度。请勿把密钥发给其他人。"
                    : "API 按用量计费，需要单独充值；聊天会员不等同于 API 额度。密钥只保存在本机安全存储里，不会上传到任何服务器。"}
                </p>
              </div>
            )}
            {tutorialStep === 1 && (
              <div className="tutorial-content">
                <p>
                  {MULTI_PROVIDER_ENABLED
                    ? "点击应用中的“AI 设置”，把刚复制的密钥粘贴到“API Key”输入框，然后点击“完成”。"
                    : "点击应用中的“AI 设置”，把刚复制的密钥粘贴到“API Key”输入框，然后点击“保存并完成”。"}
                </p>
                <p>
                  {MULTI_PROVIDER_ENABLED
                    ? "在“AI 设置”中选择服务商，模型和接口地址会自动填好。使用自定义服务时，再按服务方说明填写这两项。"
                    : `模型（${provider.model}）与接口地址已经填好，不用修改；需要换模型时在 AI 设置里改“模型”一项即可。`}
                </p>
                <p className="tutorial-note">
                  {aiKeysPersisted
                    ? "密钥会保存在 Android 安全存储中，关闭应用后仍可使用；你可以在 AI 设置中随时清除。"
                    : "当前桌面版只在本次运行期间保留密钥，关闭应用后需要重新输入；你可以在 AI 设置中随时清除。"}
                </p>
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
            if (event.target === event.currentTarget) {
              flushAiKeysWrite();
              setSettingsOpen(false);
            }
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
                onClick={() => {
                  flushAiKeysWrite();
                  setSettingsOpen(false);
                }}
              >
                <X size={19} />
              </button>
            </div>
            <p className="modal-intro">
              {nativeAiSettings
                ? aiKeysPersisted
                  ? "使用兼容 Chat Completions 的服务生成行程和 AI 管家分析。Key 保存在 Android 安全存储中，关闭应用后仍可继续使用。"
                  : "使用兼容 Chat Completions 的服务生成行程和 AI 管家分析。桌面版只在本次运行期间保留 Key，关闭应用后需要重新输入。"
                : "网页端 AI 由账号服务代理，浏览器不会保存或接触 API Key。请在账号页查看服务状态；管理员配置 AI 后即可使用。"}
            </p>
            <section className="self-check" aria-label="应用自检与更新">
              <div className="self-check__head">
                <div>
                  <strong>应用自检与更新</strong>
                  <small>检查行程数据、本机存储、安全存储、网络和新版本</small>
                </div>
                <button
                  className="self-check__run"
                  type="button"
                  onClick={() => void runSelfCheck()}
                  disabled={selfCheckBusy}
                >
                  <RefreshCw size={14} className={selfCheckBusy ? "spin" : ""} />
                  {selfCheckBusy ? "自检中" : "立即自检"}
                </button>
              </div>
              {selfCheckItems.length ? (
                <div className="self-check__items">
                  {selfCheckItems.map((item) => (
                    <div className="self-check__item" key={item.label}>
                      <span className={`self-check__status ${item.status}`}>
                        {item.status === "ok" ? "正常" : item.status === "warn" ? "提示" : "异常"}
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <small>{item.detail}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="self-check__empty">还没有运行自检。建议出发前检查一次，结果只读，不会修改行程。</p>
              )}
              {selfCheckAt ? <small className="self-check__time">上次检查：{selfCheckAt}</small> : null}
              {(availableUpdate || androidUpdate) ? (
                <div className="self-check__update">
                  <span>已发现 v{availableUpdate?.version ?? androidUpdate?.version}，现在可以完成更新。</span>
                  <button
                    type="button"
                    onClick={() => void (androidUpdate ? installAndroidUpdate() : installUpdate())}
                    disabled={updateBusy}
                  >
                    {updateBusy ? "处理中..." : androidUpdate ? "下载并安装" : "立即更新"}
                  </button>
                </div>
              ) : null}
            </section>
            <section className="ui-preferences" aria-label="交互反馈设置">
              <div className="ui-preferences__head">
                <div>
                  <strong>交互反馈</strong>
                  <small>提示音与页面过渡均为本机设置</small>
                </div>
                <label className="ui-switch">
                  <input
                    type="checkbox"
                    checked={uiPreferences.soundEnabled}
                    onChange={(event) => updatePreferences({ soundEnabled: event.target.checked })}
                  />
                  <span>提示音</span>
                </label>
              </div>
              <label className="field ui-volume">
                <span>提示音音量 <b>{Math.round(uiPreferences.soundVolume * 100)}%</b></span>
                  <input
                    type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={uiPreferences.soundVolume}
                  disabled={!uiPreferences.soundEnabled}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    updatePreferences({ soundVolume: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0 });
                  }}
                />
              </label>
              <label className="ui-switch ui-motion">
                <input
                  type="checkbox"
                  checked={uiPreferences.motionEnabled}
                  onChange={(event) => updatePreferences({ motionEnabled: event.target.checked })}
                />
                <span>启用页面入场动画</span>
              </label>
              <button className="ui-test-sound" type="button" onClick={() => play("success")}>
                播放测试音
              </button>
            </section>
            {accountEntryVisible() ? (
              <section className="ui-preferences" aria-label="账号与同步">
                <div className="ui-preferences__head">
                  <div>
                    <strong>账号（可选）</strong>
                    <small>
                      途迹的本机功能不依赖账号；只有需要多设备同步或服务端 AI 时才登录。
                    </small>
                  </div>
                </div>
                <button
                  className="ui-test-sound"
                  type="button"
                  onClick={() => {
                    flushAiKeysWrite();
                    setSettingsOpen(false);
                    setView("account");
                  }}
                >
                  {auth.user ? `已登录：${auth.user.nickname || auth.user.email || auth.user.phone || "账号"}` : "打开账号页"}
                </button>
              </section>
            ) : null}
            <section className="ui-preferences" aria-label="应用锁">
              <div className="ui-preferences__head">
                <div>
                  <strong>隐私与安全</strong>
                  <small>手机可能被家人孩子拿到时，可加一道应用锁</small>
                </div>
              </div>
              <LockSettings enabled={lockEnabled} onEnabledChange={setLockEnabled} />
            </section>
            <section className="ui-preferences backup-host" aria-label="数据备份与恢复">
              <div className="ui-preferences__head">
                <div>
                  <strong>数据备份与恢复</strong>
                  <small>
                    行程、记账、清单、打卡都在本机。换手机或重装前请先导出一份 .routebackup。
                  </small>
                </div>
              </div>
              <BackupPanel
                appVersion={APP_VERSION}
                destination={trip.destination}
                buildSource={collectBackupSource}
                onRestore={async (data, _sections, origin) => {
                  flushAiKeysWrite();
                  return restoreFromData(data as Parameters<typeof restoreFromData>[0], origin);
                }}
              />
            </section>
            {nativeAiSettings ? <div className="settings-help">
              <strong>第一次使用？</strong>
              <span>
                {MULTI_PROVIDER_ENABLED
                  ? "选择服务商后，打开对应页面创建 API Key，复制后粘贴到下方。各服务的计费和额度独立。"
                  : `打开 ${provider.name} 控制台创建 API Key，复制后粘贴到下方。按用量计费，需单独充值；勾选「记住」之外本机不会把它发到别处。`}
              </span>
              <div>
                {providerKeyPage ? (
                  <button onClick={() => openExternal(providerKeyPage)}>
                    获取 API Key <ExternalLink size={14} />
                  </button>
                ) : null}
                <button onClick={showTutorial}>查看完整教程</button>
              </div>
            </div> : null}
            {nativeAiSettings ? <label className="field">
              <span>AI 服务商</span>
              <select value={providerId} onChange={(event) => selectProvider(event.target.value as ProviderId)}>
                {(MULTI_PROVIDER_ENABLED ? providers : providers.filter((item) => item.id === PRIMARY_PROVIDER_ID)).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <small className="provider-note">{provider.note}</small>
            </label> : null}
            {nativeAiSettings ? <label className="field">
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder="在这里粘贴你的 API Key"
                maxLength={512}
                onChange={(event) => {
                  const value = event.target.value;
                  const next = { ...apiKeys, [providerId]: value };
                  setApiKeys(next);
                  saveAiSetting("route-ai-keys", next);
                }}
                onBlur={flushAiKeysWrite}
              />
            </label> : null}
            {nativeAiSettings ? <label className="field">
              <span>模型</span>
              <input
                value={model}
                onChange={(event) => {
                  const value = event.target.value;
                  setModel(value);
                  saveAiSetting("route-ai-model", value);
                }}
              />
            </label> : null}
            {nativeAiSettings ? <label className="field">
              <span>接口地址</span>
              <input
                value={endpoint}
                onChange={(event) => {
                  const value = event.target.value;
                  setEndpoint(value);
                  saveAiSetting("route-ai-endpoint", value);
                }}
              />
            </label> : <p className="settings-hint">网页端不保存 AI Key。账号服务管理员配置 AI 后，登录账号即可生成攻略。</p>}
            {nativeAiSettings ? <div className="settings-actions">
              <button
                className="modal-secondary"
                onClick={() => {
                  flushAiKeysWrite();
                  setApiKeys((previous) => {
                    const next = { ...previous };
                    delete next[providerId];
                    aiKeysVersion.current += 1;
                    if (isAndroidSecureStore()) void queueAiKeysWrite(next).then((ok) => {
                      if (!ok) {
                        setError("AI Key 清除失败，请检查设备存储空间");
                        return;
                      }
                      try { localStorage.removeItem("route-ai-keys"); } catch { /* ignore */ }
                    });
                    else void deleteSecure("route-ai-keys").then(() => saveAiSetting("route-ai-keys", next));
                    return next;
                  });
                }}
              >
                清除本机 Key
              </button>
              <button
                className="modal-primary"
                onClick={() => {
                  flushAiKeysWrite();
                  setSettingsOpen(false);
                }}
              >
                保存并完成
              </button>
            </div> : null}
            <div className="settings-about">
              <strong>途迹 v{APP_VERSION}</strong>
              <span>
                行程、账单、打包、打卡与提醒全部保存在本机，不会上传服务器。AI 生成、AI 管家深度分析与天气刷新需要网络，其余功能可离线使用。
              </span>
              <span>
                卸载应用或系统清除数据会删除本机内容；换手机前请先在「数据备份与恢复」里导出一份 .routebackup。
              </span>
            </div>
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
    </>
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
              maxLength={80}
              onChange={(event) => change("type", event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>安排名称</span>
            <input
              required
              value={value.title}
              maxLength={160}
              onChange={(event) => change("title", event.target.value)}
          />
        </label>
        <label className="field">
          <span>地点</span>
            <input
              value={value.location}
              maxLength={160}
              onChange={(event) => change("location", event.target.value)}
          />
        </label>
        <label className="field">
          <span>说明</span>
            <textarea
              rows={3}
              value={value.detail}
              maxLength={2000}
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
                change(
                  "estimatedCost",
                  Number.isFinite(Number(event.target.value))
                    ? Math.max(0, Number(event.target.value))
                    : 0,
                )
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
                  Number.isFinite(Number(event.target.value))
                    ? Math.max(1, Number(event.target.value))
                    : 1,
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
