// 应用内后台标签页的共享运行时（2026-07-09 用户拍板:后台在主窗口内打开）。
// providers(openStudioBrowser 桌面路径)、WorkspaceTabsBar(关标签)与
// BrowserPanesHost(常驻面板宿主)三方靠这里的事件与工具函数解耦。
import { navigate } from '../router';
import type { DraftPayload } from './browser-draft';

export const OPEN_BROWSER_PANE_EVENT = 'od:browser-pane:open';
export const BROWSER_TAB_CLOSED_EVENT = 'od:browser-pane:closed';

export interface BrowserPaneRequest {
  platform: string;
  account: string;
  url: string;
  /** 「一键存草稿」:面板加载完成后自动执行的填稿载荷(一次性)。 */
  draft?: DraftPayload;
}

/** 平台中文名（后台标签标题/工具条 chip 共用;客户定制中文直写）。 */
export const BROWSER_PLATFORM_TITLES: Record<string, string> = {
  'wechat-mp': '公众号',
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  bilibili: 'B站',
  shipinhao: '视频号',
  zhihu: '知乎',
};

/**
 * 平台 id 归一:内容平台(contracts)叫 shipinhao,sau 发布链叫 tencent——
 * 同一个视频号账号从账号页与短视频台打开必须落同一档案,否则要登两次。
 */
export function normalizeBrowserPlatform(platform: string): string {
  return platform === 'tencent' ? 'shipinhao' : platform;
}

/**
 * 档案段清洗 —— 必须与 apps/desktop/src/main/embedded-browser.ts 的
 * sanitizeProfileSegment 完全一致:同一 平台×账号 在「独立窗」与「应用内
 * 标签」两条路径要落进同一个 persist 分区,登录态才互通。
 * 中文等非 ASCII 账号名清洗有损(全变 '-' 再剥掉=空),旧实现让所有中文
 * 账号兜底到 'main' 共用登录态;有损时附加 FNV-1a 哈希,不同账号绝不同段。
 */
export function sanitizeProfileSegment(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  const lowered = trimmed.toLowerCase();
  const cleaned = lowered
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (/^[a-z0-9_-]+$/.test(lowered)) return cleaned || null;
  let h = 0x811c9dc5;
  for (const ch of trimmed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${cleaned ? `${cleaned}-` : ''}u${h.toString(16)}`;
}

/** webview partition —— 前缀与主进程 PARTITION_PREFIX 锚定。 */
export function browserPanePartition(platform: string, account: string): string {
  const p = sanitizeProfileSegment(platform) ?? 'unknown';
  const a = sanitizeProfileSegment(account) ?? 'main';
  return `persist:od-browser-${p}-${a}`;
}

export function browserPaneKey(platform: string, account: string): string {
  return `${platform}::${account}`;
}

/** 打开(或聚焦)一个应用内后台标签:先递 pane 规格,再走路由开标签。 */
export function openBrowserPane(req: BrowserPaneRequest): void {
  window.dispatchEvent(new CustomEvent<BrowserPaneRequest>(OPEN_BROWSER_PANE_EVENT, { detail: req }));
  navigate({ kind: 'browser', platform: req.platform, account: req.account });
}

/** 标签被关闭 → 通知宿主销毁对应 webview(结束 keep-alive)。 */
export function notifyBrowserTabClosed(platform: string, account: string): void {
  window.dispatchEvent(
    new CustomEvent<{ platform: string; account: string }>(BROWSER_TAB_CLOSED_EVENT, {
      detail: { platform, account },
    }),
  );
}
