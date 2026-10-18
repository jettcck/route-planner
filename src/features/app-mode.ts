/**
 * 运行模式：单人私人版 / 多用户账号版。
 *
 * 背景
 * - 首版只供个人使用，装机后不应被登录墙挡住；账号服务是**可选**能力。
 * - 同一份源码仍要能编出带账号的构建，因此用构建期开关而不是运行期配置：
 *   `VITE_ANDROID_SINGLE_USER=true`（写在 .env / CI env）。
 *
 * 约定
 * - 单人模式：五个功能页（行程/打包/记账/打卡/提醒）直接可用，不做登录校验；
 *   「账号」不再是主导航标签，只在「设置」里作为可选入口出现。
 * - 多用户模式：保持原有的登录门控行为。
 * - 开关在**构建期**求值（import.meta.env 是静态替换），运行时无法被
 *   WebView 存储篡改改成另一种模式。
 */
import { isTauri } from "@tauri-apps/api/core";

const RAW = import.meta.env.VITE_ANDROID_SINGLE_USER;

/** 构建期开关：true 表示单人私人模式 */
export const SINGLE_USER =
  typeof RAW === "string" ? RAW.trim().toLowerCase() === "true" : RAW === true;

const IS_ANDROID_RUNTIME =
  isTauri() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/**
 * 安卓私人版默认落地页：行程规划。
 * 用户明确要求「Android 默认进入行程页」，不再先落到账号页。
 */
export const DEFAULT_VIEW: "trip" | "account" = SINGLE_USER || IS_ANDROID_RUNTIME ? "trip" : "account";

/**
 * 是否需要登录才能使用本机功能。
 * - 单人模式：永不需要。
 * - 多用户模式：需要（由 App 的 auth 门控决定）。
 */
export function requiresAccount(): boolean {
  return !SINGLE_USER;
}

/** 账号入口是否可见（单人模式下只作为「设置」内的可选入口） */
export function accountEntryVisible(): boolean {
  return true;
}

/**
 * 当前构建是否允许公开注册 / 短信登录 / 密码重置。
 * 单人版关闭这三项：它们对私人使用无价值，却扩大攻击面。
 */
export const PUBLIC_SIGNUP_ENABLED = !SINGLE_USER;
export const SMS_LOGIN_ENABLED = !SINGLE_USER;
export const PASSWORD_RESET_ENABLED = !SINGLE_USER;

/**
 * 当前构建是否允许选择多个 AI 服务商。
 * 单人版只保留一个主要服务商（DeepSeek），降低配置负担与 Key 泄露面。
 */
export const MULTI_PROVIDER_ENABLED = !SINGLE_USER;

/** 调试/验收构建标记（沿用既有 VITE_ENABLE_ANDROID_DIAGNOSTICS 约定） */
export const DIAGNOSTICS_ENABLED = import.meta.env.VITE_ENABLE_ANDROID_DIAGNOSTICS === "true";
