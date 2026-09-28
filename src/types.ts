import { z } from "zod";

export const activitySchema = z.object({
  time: z.string(),
  title: z.string().min(1),
  detail: z.string(),
  location: z.string(),
  estimatedCost: z.number().nonnegative(),
  durationMinutes: z.number().positive(),
  type: z.string(),
});
export const tripSchema = z.object({
  title: z.string().min(1),
  destination: z.string().min(1),
  overview: z.string(),
  days: z
    .array(
      z.object({
        date: z.string(),
        theme: z.string(),
        activities: z.array(activitySchema),
      }),
    )
    .min(1),
  tips: z.array(z.string()),
  sample: z.boolean().optional(),
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
