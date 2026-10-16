import { saveJson } from "./features/store";

export type Weather = {
  date: string;
  label: string;
  summary: string;
  /** 结构化字段，供出行提醒做判断；接口异常时为 undefined。 */
  min?: number;
  max?: number;
  rain?: number;
  code?: number;
};

export type CurrentWeather = {
  label: string;
  temperature?: number;
  apparentTemperature?: number;
  windSpeed?: number;
  rain?: number;
  code?: number;
  observedAt: string;
};

export type WeatherResult = {
  days: Weather[];
  current?: CurrentWeather;
  message: string;
  source: "location" | "destination";
  /** 成功从服务端获取（或写入缓存）的时间。 */
  updatedAt: string;
  /** 网络不可用时显示了过期缓存。 */
  stale?: boolean;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_PREFIX = "route-weather-cache:";
const MAX_WEATHER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_WEATHER_DAYS = 31;

type WeatherCacheEntry = {
  savedAt: number;
  result: Omit<WeatherResult, "stale">;
};

const weatherNames: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾",
  51: "毛毛雨",
  53: "小雨",
  55: "小雨",
  56: "冻雨",
  57: "冻雨",
  61: "小雨",
  63: "雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷雨",
  96: "雷雨伴冰雹",
  99: "雷雨伴冰雹",
};

function weatherLabel(code: number | undefined) {
  return typeof code === "number" ? weatherNames[code] || "天气多变" : "天气未知";
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchJson(url: string, signal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) abortIfNeeded(signal);
    signal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`weather request failed: ${response.status}`);
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_WEATHER_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("weather response too large");
    }
    if (!response.body) throw new Error("weather response body missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > MAX_WEATHER_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("weather response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, any>;
  } catch (error) {
    if (timedOut) throw new Error("weather request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function currentFromForecast(forecast: Record<string, any>): CurrentWeather | undefined {
  const current = forecast.current;
  if (!current) return undefined;
  const code = numberOrUndefined(current.weather_code);
  return {
    label: weatherLabel(code),
    temperature: numberOrUndefined(current.temperature_2m),
    apparentTemperature: numberOrUndefined(current.apparent_temperature),
    windSpeed: numberOrUndefined(current.wind_speed_10m),
    rain: numberOrUndefined(current.precipitation),
    code,
    observedAt: typeof current.time === "string" ? current.time : new Date().toISOString(),
  };
}

function buildDays(forecast: Record<string, any>, dates: string[]) {
  const daily = forecast.daily;
  if (!daily?.time) return [] as Weather[];
  return dates.flatMap((date) => {
    const index = daily.time.indexOf(date);
    if (index < 0) return [];
    const code = numberOrUndefined(daily.weather_code?.[index]);
    const minValue = numberOrUndefined(daily.temperature_2m_min?.[index]);
    const maxValue = numberOrUndefined(daily.temperature_2m_max?.[index]);
    const rain = numberOrUndefined(daily.precipitation_probability_max?.[index]) ?? 0;
    const min = minValue === undefined ? undefined : Math.round(minValue);
    const max = maxValue === undefined ? undefined : Math.round(maxValue);
    const label = weatherLabel(code);
    const temperature = min !== undefined && max !== undefined ? ` · ${min}–${max}°C` : "";
    return [{
      date,
      label,
      summary: `${label}${temperature} · 降水概率 ${rain}%`,
      min,
      max,
      rain,
      code,
    }];
  });
}

async function forecastAt(latitude: number, longitude: number, dates: string[], signal?: AbortSignal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "weather_code,temperature_2m,apparent_temperature,precipitation,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "16",
  }).toString();
  const forecast = await fetchJson(url.toString(), signal);
  return { days: buildDays(forecast, dates), current: currentFromForecast(forecast) };
}

function cacheKey(destination: string, dates: string[], latitude?: number, longitude?: number) {
  const location = latitude === undefined || longitude === undefined
    ? "destination"
    : `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  return `${CACHE_PREFIX}v2:${encodeURIComponent(destination.trim().toLowerCase())}|${dates.join(",")}|${location}`;
}

function legacyCacheKey(destination: string, dates: string[], latitude?: number, longitude?: number) {
  const location = latitude === undefined || longitude === undefined
    ? "destination"
    : `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  return `${CACHE_PREFIX}${destination.trim().toLowerCase()}|${dates.join(",")}|${location}`;
}

function readCache(key: string): WeatherCacheEntry | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WeatherCacheEntry;
    const result = parsed?.result;
    const finiteOptional = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));
    const validDate = (value: unknown) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split("-").map(Number);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      return parsedDate.getUTCFullYear() === year &&
        parsedDate.getUTCMonth() === month - 1 &&
        parsedDate.getUTCDate() === day;
    };
    const validDays = Array.isArray(result?.days) && result.days.length <= MAX_CACHED_WEATHER_DAYS && result.days.every((item) =>
      item && validDate(item.date) &&
      typeof item.label === "string" && item.label.length <= 80 &&
      typeof item.summary === "string" && item.summary.length <= 500 &&
      finiteOptional(item.min) && finiteOptional(item.max) && finiteOptional(item.rain) && finiteOptional(item.code),
    );
    const validCurrent = result?.current === undefined || Boolean(
      result.current && typeof result.current.label === "string" && result.current.label.length <= 80 &&
      typeof result.current.observedAt === "string" && result.current.observedAt.length <= 80 &&
      finiteOptional(result.current.temperature) && finiteOptional(result.current.apparentTemperature) &&
      finiteOptional(result.current.windSpeed) && finiteOptional(result.current.rain) && finiteOptional(result.current.code),
    );
    if (!parsed || !Number.isFinite(parsed.savedAt) || parsed.savedAt < 0 ||
      !result || !validDays || !validCurrent || typeof result.message !== "string" ||
      (result.source !== "location" && result.source !== "destination") || typeof result.updatedAt !== "string") {
      localStorage.removeItem(key);
      return undefined;
    }
    return parsed;
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore corrupt storage */ }
    return undefined;
  }
}

function writeCache(key: string, result: Omit<WeatherResult, "stale">, savedAt = Date.now()) {
  pruneWeatherCache(key);
  saveJson(key, { savedAt, result } satisfies WeatherCacheEntry);
}

/**
 * Persist weather carried by an imported trip backup as an expired snapshot.
 * After a restart it can serve as an offline fallback, but it will never be
 * treated as current data without a fresh network attempt.
 */
export function saveWeatherBackup(destination: string, dates: string[], days: Weather[]): boolean {
  if (!destination.trim() || !dates.length) return true;
  const key = cacheKey(destination, dates);
  const result: Omit<WeatherResult, "stale"> = {
    days,
    message: "来自行程备份的天气数据",
    source: "destination",
    updatedAt: new Date().toISOString(),
  };
  pruneWeatherCache(key);
  return saveJson(key, {
    savedAt: Math.max(0, Date.now() - CACHE_TTL_MS - 1),
    result,
  } satisfies WeatherCacheEntry);
}

/** 天气只做短期离线兜底，避免反复查询不同目的地耗尽 WebView 存储。 */
function pruneWeatherCache(keepKey: string) {
  try {
    const now = Date.now();
    const entries: { key: string; savedAt: number }[] = [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (!key.startsWith(CACHE_PREFIX) || key === keepKey) continue;
      let savedAt = 0;
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) as Partial<WeatherCacheEntry> : null;
        savedAt = typeof parsed?.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : 0;
      } catch {
        savedAt = 0;
      }
      if (!savedAt || now - savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(key);
      } else {
        entries.push({ key, savedAt });
      }
    }
    entries
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(16)
      .forEach(({ key }) => localStorage.removeItem(key));
  } catch {
    // Cache cleanup is best effort; the weather request itself remains usable.
  }
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export async function getWeather(
  destination: string,
  dates: string[],
  options: { signal?: AbortSignal; latitude?: number; longitude?: number } = {},
): Promise<WeatherResult> {
  abortIfNeeded(options.signal);
  if (!dates.length) return { days: [], message: "暂无行程日期", source: "destination", updatedAt: "" };
  if (!destination) return { days: [], message: "暂无目的地", source: "destination", updatedAt: "" };

  const key = cacheKey(destination, dates, options.latitude, options.longitude);
  let cached = readCache(key);
  if (!cached) {
    // Upgrade the historical unencoded key only when the v2 key is absent.
    // A deliberately saved empty/expired v2 snapshot remains authoritative.
    const oldKey = legacyCacheKey(destination, dates, options.latitude, options.longitude);
    const legacy = readCache(oldKey);
    if (legacy) {
      cached = legacy;
      writeCache(key, legacy.result, legacy.savedAt);
      try { localStorage.removeItem(oldKey); } catch { /* best effort */ }
    }
  }
  // A clock change or crafted localStorage value must not turn a future
  // timestamp into an effectively permanent fresh cache entry.
  const now = Date.now();
  if (cached && cached.savedAt <= now && now - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.result, message: `${cached.result.message} · ${formatCacheAge(cached.savedAt)}` };
  }

  try {
    return await fetchWeather(destination, dates, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (cached) {
      return {
        ...cached.result,
        stale: true,
        message: `网络不可用，显示 ${formatCacheAge(cached.savedAt)} 的天气缓存`,
      };
    }
    throw error;
  }
}

async function fetchWeather(
  destination: string,
  dates: string[],
  options: { signal?: AbortSignal; latitude?: number; longitude?: number },
): Promise<WeatherResult> {
  abortIfNeeded(options.signal);

  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.search = new URLSearchParams({
    name: destination,
    count: "1",
    language: "zh",
    format: "json",
  }).toString();
  const geo = await fetchJson(geoUrl.toString(), options.signal);
  const place = geo.results?.[0];
  const destinationLatitude = numberOrUndefined(place?.latitude);
  const destinationLongitude = numberOrUndefined(place?.longitude);
  if (destinationLatitude === undefined || destinationLongitude === undefined) {
    return { days: [], message: "未找到目的地天气", source: "destination", updatedAt: new Date().toISOString() };
  }

  const destinationForecast = await forecastAt(
    destinationLatitude,
    destinationLongitude,
    dates,
    options.signal,
  );
  let current = destinationForecast.current;
  let source: WeatherResult["source"] = "destination";
  let locationFallback = false;
  if (options.latitude !== undefined && options.longitude !== undefined) {
    try {
      const locationForecast = await forecastAt(options.latitude, options.longitude, [], options.signal);
      current = locationForecast.current;
      source = "location";
    } catch {
      // The destination forecast is still useful when a second request for
      // the device location is blocked, rate-limited, or temporarily offline.
      // Preserve abort semantics so navigating away still cancels promptly.
      abortIfNeeded(options.signal);
      locationFallback = true;
    }
  }
  const result: Omit<WeatherResult, "stale"> = {
    days: destinationForecast.days,
    current,
    message: destinationForecast.days.length
      ? source === "location"
        ? "当前位置实时天气 · 目的地未来 16 天预报"
        : locationFallback
          ? "目的地实时天气 · 当前位置暂不可用 · 未来 16 天预报"
          : "目的地实时天气 · 未来 16 天预报"
      : "超出目的地预报范围",
    source,
    updatedAt: new Date().toISOString(),
  };
  writeCache(cacheKey(destination, dates, options.latitude, options.longitude), result);
  return result;
}

function formatCacheAge(savedAt: number) {
  const minutes = Math.max(1, Math.round((Date.now() - savedAt) / 60_000));
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

export function currentWeatherAdvice(current?: CurrentWeather) {
  if (!current) return "暂未获取到当前天气，出发前请再次刷新。";
  const advice: string[] = [];
  if ((current.code ?? 0) >= 95) advice.push("当前有雷雨迹象，避开山顶、索道、水边和空旷地带");
  else if ((current.rain ?? 0) > 0 || (current.code ?? 0) >= 51) advice.push("当前有降水，带伞并为户外项目准备室内备选");
  if ((current.temperature ?? 99) <= 5) advice.push("体感偏冷，增加保暖内层");
  if ((current.temperature ?? -99) >= 33) advice.push("当前高温，减少正午户外活动并及时补水防晒");
  if ((current.windSpeed ?? 0) >= 30) advice.push("风力较大，谨慎安排高处、滨水和骑行活动");
  return advice.length ? advice.join("；") + "。" : "当前天气适合常规出行，仍建议随身携带饮水并关注天气变化。";
}
