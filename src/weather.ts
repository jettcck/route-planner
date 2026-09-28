export type Weather = { date: string; label: string; summary: string };

const weatherNames: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾",
  51: "小雨",
  53: "小雨",
  55: "小雨",
  61: "雨",
  63: "雨",
  65: "大雨",
  71: "雪",
  73: "雪",
  75: "大雪",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  95: "雷雨",
};

export async function getWeather(
  destination: string,
  dates: string[],
): Promise<{ days: Weather[]; message: string }> {
  if (!destination || !dates.length) return { days: [], message: "暂无目的地" };
  const geoResponse = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=zh&format=json`,
  );
  if (!geoResponse.ok) throw new Error("geocoding failed");
  const geo = await geoResponse.json();
  const place = geo.results?.[0];
  if (!place) return { days: [], message: "未找到城市天气" };
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16`,
  );
  if (!response.ok) throw new Error("forecast failed");
  const forecast = await response.json();
  const days = dates.flatMap((date) => {
    const index = forecast.daily?.time?.indexOf(date) ?? -1;
    if (index < 0) return [];
    const label =
      weatherNames[forecast.daily.weather_code[index]] || "天气多变";
    return [
      {
        date,
        label,
        summary: `${label} · ${Math.round(forecast.daily.temperature_2m_min[index])}–${Math.round(forecast.daily.temperature_2m_max[index])}°C · 降水概率 ${forecast.daily.precipitation_probability_max[index]}%`,
      },
    ];
  });
  return { days, message: days.length ? "未来 16 天预报" : "超出预报范围" };
}
