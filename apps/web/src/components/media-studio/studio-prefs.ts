// 写作/生成选择器的「上次选择即默认」偏好（2026-07-10 用户报：字数等
// 每次都重置，应记住上次的当默认）。通用 localStorage 存取，与
// image-model-pref.ts 同一模式：等于默认值时清键，保持存储干净。
//
// 键约定：open-design:studio:<name>，字数按平台分键（各台默认不同，微博
// 的 100-140 不应盖掉公众号的 1500-2000）。
const PREFIX = 'open-design:studio:';

export function loadStudioPref(name: string, fallback: string): string {
  try {
    return window.localStorage.getItem(PREFIX + name) || fallback;
  } catch {
    return fallback;
  }
}

export function saveStudioPref(name: string, value: string, fallback: string): void {
  try {
    if (!value || value === fallback) window.localStorage.removeItem(PREFIX + name);
    else window.localStorage.setItem(PREFIX + name, value);
  } catch {
    /* storage unavailable — selection stays for this session only */
  }
}
