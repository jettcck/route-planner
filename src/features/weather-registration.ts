export type WeatherMonitorStatus = {
  notificationsEnabled: boolean;
  configured?: boolean;
  periodic?: unknown[];
};

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
