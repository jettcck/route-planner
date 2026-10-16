import type { Trip } from "../types";

export type CheckIn = {
  /** 打卡时间（ISO 字符串）。 */
  at: string;
  note: string;
};

export type CheckInMap = Record<string, CheckIn>;

/** Keys from imported/local data must never mutate an object's prototype. */
function isSafeRecordKey(key: string) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/** 清洗本地打卡记录；无效记录会被丢弃，保留其余可用足迹。 */
export function sanitizeCheckIns(value: unknown): CheckInMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  // A null prototype keeps even legacy callers safe if a crafted backup was
  // already parsed before this sanitizer ran.
  const result = Object.create(null) as CheckInMap;
  for (const [key, raw] of Object.entries(value).slice(0, 1_000)) {
    // v2 keys URI-encode user text, so a valid 160-character title/location
    // can be longer than the historical 300-character ceiling.
    if (!key || key.length > 4_096 || !isSafeRecordKey(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<CheckIn>;
    if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at)) || record.at.length > 80) continue;
    if (typeof record.note !== "string" || record.note.length > 2_000) continue;
    result[key] = { at: record.at, note: record.note };
  }
  return result;
}

/** 兼容旧数据的活动键；标题相同的活动也通过序号区分。 */
export function activityKey(trip: Trip, dayIndex: number, index: number) {
  const day = trip.days[dayIndex];
  const activity = day?.activities[index];
  return `${day?.date ?? dayIndex}#${index}#${activity?.title ?? ""}`;
}

/** 活动被编辑或排序后仍可追踪的键，优先使用内容指纹。 */
export function activityLegacyStableKey(trip: Trip, dayIndex: number, index: number) {
  const day = trip.days[dayIndex];
  const activity = day?.activities[index];
  if (!activity) return activityKey(trip, dayIndex, index);
  return `${day?.date ?? dayIndex}#${activity.time}#${activity.title}#${activity.location}`;
}

/** Historical content key used by builds before the collision-safe format. */
export function activityHistoricalStableKey(trip: Trip, dayIndex: number, index: number) {
  const day = trip.days[dayIndex];
  const activity = day?.activities[index];
  if (!activity) return activityKey(trip, dayIndex, index);
  const legacyKey = activityLegacyStableKey(trip, dayIndex, index);
  const occurrence = day.activities
    .slice(0, index)
    .filter((_, previousIndex) => activityLegacyStableKey(trip, dayIndex, previousIndex) === legacyKey)
    .length;
  return `${legacyKey}#${occurrence}`;
}

/**
 * Add an occurrence number so duplicate activities do not share one check-in.
 * The old content-only key remains readable through readCheckIn for migration.
 */
export function activityStableKey(trip: Trip, dayIndex: number, index: number) {
  const day = trip.days[dayIndex];
  const activity = day?.activities[index];
  if (!activity) return activityKey(trip, dayIndex, index);
  const occurrence = day.activities
    .slice(0, index)
    .filter((_, previousIndex) => activityLegacyStableKey(trip, dayIndex, previousIndex) === activityLegacyStableKey(trip, dayIndex, index))
    .length;
  // Encode the tuple as one opaque component so user-entered '#' and other
  // delimiters cannot make two different activities share a check-in key.
  return `v2:${encodeURIComponent(JSON.stringify([
    day.date,
    activity.time,
    activity.title,
    activity.location,
    occurrence,
  ]))}`;
}

export function readCheckIn(checkIns: CheckInMap, trip: Trip, dayIndex: number, index: number) {
  const own = (key: string) => Object.prototype.hasOwnProperty.call(checkIns, key) ? checkIns[key] : undefined;
  return (
    own(activityStableKey(trip, dayIndex, index)) ??
    own(activityHistoricalStableKey(trip, dayIndex, index)) ??
    own(activityLegacyStableKey(trip, dayIndex, index)) ??
    own(activityKey(trip, dayIndex, index))
  );
}

export function totalActivities(trip: Trip) {
  return trip.days.reduce((sum, day) => sum + day.activities.length, 0);
}

export function checkInStats(trip: Trip, checkIns: CheckInMap) {
  const total = totalActivities(trip);
  const perDay = trip.days.map((day, dayIndex) => ({
    date: day.date,
    theme: day.theme,
    total: day.activities.length,
    done: day.activities.filter((_, index) => readCheckIn(checkIns, trip, dayIndex, index)).length,
  }));
  const records = trip.days.flatMap((day, dayIndex) =>
    day.activities
      .map((_, index) => readCheckIn(checkIns, trip, dayIndex, index))
      .filter((item): item is CheckIn => Boolean(item)),
  );
  const done = records.length;
  const times = records
    .map((item) => item.at)
    .filter(Boolean)
    .sort();
  return {
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0,
    perDay,
    firstAt: times[0] ?? "",
    lastAt: times[times.length - 1] ?? "",
  };
}

export function formatCheckInTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
