import { z } from "zod";
import type { Activity, Trip } from "../src/types";
import type { Weather } from "../src/weather";
export type AgentAction =
  | { type: "reschedule_activity"; day: number; index: number; time: string; reason: string }
  | { type: "replace_activity"; day: number; index: number; activity: Activity; reason: string }
  | { type: "add_todo"; text: string; reason: string };
export type AgentContext = {
  instruction: string; trip: Trip; budget: number; travelers: number; spent: number;
  completed: { day: number; index: number }[]; reminders: string[];
  issues?: { level: "risk" | "warn" | "info"; title: string; detail: string }[];
  weather: { source: "Open-Meteo"; updatedAt: string; stale: boolean; days: Weather[] };
};
export type AgentProposal = { summary: string; warnings: string[]; actions: AgentAction[] };
export const agentActionSchema: z.ZodType<AgentAction>;
export const agentContextSchema: z.ZodType<AgentContext>;
export const agentProposalSchema: z.ZodType<AgentProposal>;
export function previewAgentAction(context: AgentContext, action: AgentAction): { trip: Trip; reminders: string[] };
export function validateAgentProposal(value: unknown, context: AgentContext): AgentProposal;
export const AGENT_SYSTEM_PROMPT: string;
