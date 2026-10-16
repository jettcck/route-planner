import { z } from "zod";

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须为 YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "日期无效");

const clockTime = z
  .preprocess(
    (value) => typeof value === "string" && /^\d:\d{2}$/.test(value) ? `0${value}` : value,
    z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须为 HH:MM"),
  );

export const activitySchema = z.object({
  time: clockTime,
  title: z.string().trim().min(1).max(160),
  detail: z.string().max(2_000),
  location: z.string().max(160),
  estimatedCost: z.number().finite().nonnegative().max(10_000_000),
  durationMinutes: z.number().finite().positive().max(24 * 60),
  // 类别是可选备注；允许为空，避免用户清空类别后重启应用丢失整趟行程。
  type: z.string().trim().max(80),
});
export const MAX_ACTIVITIES_PER_DAY = 100;
export const tripSchema = z.object({
  title: z.string().trim().min(1).max(160),
  destination: z.string().trim().min(1).max(120),
  overview: z.string().max(4_000),
  days: z
    .array(
      z.object({
        date: calendarDate,
        theme: z.string().trim().min(1).max(160),
        activities: z.array(activitySchema).max(MAX_ACTIVITIES_PER_DAY),
      }),
    )
    .min(1)
    .max(31),
  tips: z.array(z.string().trim().min(1).max(500)).max(100),
  sample: z.boolean().optional(),
});

export const plannerInputSchema = z.object({
  destination: z.string().trim().min(1).max(120),
  startDate: calendarDate,
  days: z.number().int().min(1).max(14),
  travelers: z.number().int().min(1).max(20),
  budget: z.number().finite().min(0).max(10_000_000),
  pace: z.enum(["轻松", "适中", "充实"]),
  interests: z.array(z.string().trim().min(1).max(40)).max(20),
  notes: z.string().max(2_000),
});
export type Activity = z.infer<typeof activitySchema>;
export type Trip = z.infer<typeof tripSchema>;
export type PlannerInput = {
  destination: string;
  startDate: string;
  days: number;
  travelers: number;
  budget: number;
  pace: "轻松" | "适中" | "充实";
  interests: string[];
  notes: string;
};
