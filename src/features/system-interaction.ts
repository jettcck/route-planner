/**
 * 系统交互豁免令牌。
 *
 * 场景：分享面板、文件选择器这类**用户主动发起**的系统 UI 会把 WebView
 * 推到 hidden。这种"离开"不代表用户把手机放下了，不该触发应用锁重锁，
 * 否则用户在分享面板里挑应用超过 60 秒，回到途迹先被口令拦住，
 * 正在进行的分享直接被打断。
 *
 * 关键设计：**只豁免一次**。
 * 早期版本用一个 180 秒的时间窗，结果是分享之后 3 分钟内的任何后台离开
 * 都不上锁——为了不打断一次分享，把应用的锁弱化了三分钟。现在改成一次性
 * 令牌：分享发起后，紧接的那一次回到前台跳过锁定；令牌随即作废，
 * 之后的后台离开照常按 60 秒计时。
 *
 * 本模块刻意不依赖任何运行时（不 import Tauri / DOM），
 * 这样可以在 Node 里直接跑时序测试（server/system-interaction-test.mjs）。
 */

export const DEFAULT_WINDOW_MS = 120_000;

let pending = false;
let deadline = 0;

/** 用户主动发起了系统交互，登记一次待消费的豁免。 */
export function beginSystemInteraction(windowMs: number = DEFAULT_WINDOW_MS) {
  pending = true;
  deadline = Date.now() + Math.max(0, windowMs);
}

/**
 * 消费一次豁免。返回 true 表示"这次回到前台是系统交互引起的，别上锁"。
 * 令牌用掉即失效；超时未用也失效（用户发起分享后真的走了）。
 */
export function consumeSystemInteraction(): boolean {
  const usable = pending && Date.now() <= deadline;
  pending = false;
  deadline = 0;
  return usable;
}

/** 仅供测试：清空状态，避免用例之间互相污染。 */
export function resetSystemInteraction() {
  pending = false;
  deadline = 0;
}
