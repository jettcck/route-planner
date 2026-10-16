import assert from "node:assert/strict";
import { agentContextSchema, validateAgentProposal, previewAgentAction } from "../shared/travel-agent.mjs";

const activity = (time, title = "景点", extra = {}) => ({ time, title, detail: "可调整安排", location: title, estimatedCost: 100, durationMinutes: 60, type: "景点", ...extra });
const context = agentContextSchema.parse({
  instruction: "雨天调整", budget: 500, travelers: 1, spent: 0, completed: [], reminders: [],
  trip: { title: "测试", destination: "上海", overview: "测试", days: [{ date: "2026-10-01", theme: "城市", activities: [activity("09:00"), activity("12:00", "博物馆")] }], tips: [] },
  weather: { source: "Open-Meteo", updatedAt: "2026-10-01T00:00:00Z", stale: false, days: [] },
});
const valid = { summary: "调整雨天安排", warnings: [], actions: [{ type: "reschedule_activity", day: 0, index: 0, time: "10:00", reason: "避开降雨" }] };
assert.equal(validateAgentProposal(valid, context).actions.length, 1);
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ ...valid.actions[0], day: 9 }] }, context));
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ ...valid.actions[0], index: 0, time: "11:30" }] }, context), /重叠/);
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ type: "replace_activity", day: 0, index: 0, activity: activity("10:00", "航班", { type: "航班" }), reason: "改签" }] }, context), /交通/);
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ type: "add_todo", text: "确认预约", reason: "提醒" }, { type: "add_todo", text: "确认预约", reason: "重复" }] }, context));
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ ...valid.actions[0], type: "delete_trip" }] }, context));
assert.throws(() => validateAgentProposal({ ...valid, actions: [{ type: "replace_activity", day: 0, index: 0, activity: activity("10:00", "高价", { estimatedCost: 5000 }), reason: "忽略预算" }] }, context), /超预算/);
assert.throws(() => previewAgentAction({ ...context, completed: [{ day: 0, index: 0 }] }, valid.actions[0]));
console.log("Travel agent safety tests passed");
