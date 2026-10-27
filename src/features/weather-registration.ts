export type WeatherMonitorStatus = {
  notificationsEnabled: boolean;
  configured?: boolean;
  periodic?: unknown[];
};

/**
 * 是否已经自动请求过通知权限。
 * Android 上第二次请求不会弹框，而是直接 startActivity 跳到「通知渠道设置」页。
 * 启动时无条件注册天气监控，就会出现"每次打开应用都被甩进系统设置"的观感，
 * 用户会以为应用打不开。所以自动请求只做一次，之后交给用户在提醒页自行判断。
 */
const PERMISSION_ASKED_KEY = "route-notification-asked";

function permissionAlreadyRequested(): boolean {
  try {
    return localStorage.getItem(PERMISSION_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function markPermissionRequested() {
  try {
    localStorage.setItem(PERMISSION_ASKED_KEY, "1");
  } catch {
    /* 存储不可用时退化为每次都问；比永久不问更安全。 */
  }
}

/** Called inside the native command queue, including the status read. */
export function createWeatherRegistration(options: {
  readStatus: () => Promise<WeatherMonitorStatus>;
  schedule: (immediate: boolean) => Promise<unknown>;
  isActive: () => boolean;
  now?: () => number;
}) {
  let lastImmediateAt: number | null = null;
  let notificationsEnabled: boolean | null = null;
  const now = options.now ?? Date.now;
  return async (initial: boolean) => {
    if (!options.isActive()) return;
    const status = await options.readStatus();
    if (!options.isActive()) return;
    const restoredPermission = notificationsEnabled === false && status.notificationsEnabled;
    notificationsEnabled = status.notificationsEnabled;
    // Android may cancel WorkManager work after storage pressure, app restore,
    // or vendor power management. Durable preferences alone then still look
    // configured, so repair a known-missing periodic request on resume.
    const monitorMissing = status.configured === false ||
      (status.configured === true && Array.isArray(status.periodic) && status.periodic.length === 0);
    // The initial schedule opens the permission prompt. Resume events while
    // access remains disabled must not repeatedly open it.
    if (!notificationsEnabled && !initial) return;
    // 首次启动可以弹一次系统权限框；弹过还没授权就走静默，
    // 否则会变成每次启动都跳「通知渠道设置」。
    if (!notificationsEnabled) {
      if (permissionAlreadyRequested()) return;
      markPermissionRequested();
    }
    const immediate = initial || restoredPermission || monitorMissing || lastImmediateAt === null ||
      now() - lastImmediateAt >= 10 * 60 * 1000;
    try {
      await options.schedule(immediate);
    } catch (error) {
      // Keep a disabled/recovered transition eligible for an immediate retry
      // when the permission prompt or WorkManager registration races activity
      // recreation.
      notificationsEnabled = false;
      throw error;
    }
    // A rejected registration must remain retryable on the next resume.
    if (immediate) lastImmediateAt = now();
    notificationsEnabled = true;
  };
}
