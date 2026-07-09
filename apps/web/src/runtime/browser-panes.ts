// 应用内后台标签页的共享运行时（2026-07-09 用户拍板:后台在主窗口内打开）。
// providers(openStudioBrowser 桌面路径)、WorkspaceTabsBar(关标签)与
// BrowserPanesHost(常驻面板宿主)三方靠这里的事件与工具函数解耦。
import { navigate } from '../router';

export const OPEN_BROWSER_PANE_EVENT = 'od:browser-pane:open';
export const BROWSER_TAB_CLOSED_EVENT = 'od:browser-pane:closed';

export interface BrowserPaneRequest {
  platform: string;
  account: string;
  url: string;
}

/** 平台中文名（后台标签标题/工具条 chip 共用;客户定制中文直写）。 */
export const BROWSER_PLATFORM_TITLES: Record<string, string> = {
  'wechat-mp': '公众号',
  douyin: '抖音',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  bilibili: 'B站',
  'wechat-channels': '视频号',
};

/**
 * 档案段清洗 —— 必须与 apps/desktop/src/main/embedded-browser.ts 的
 * sanitizeProfileSegment 完全一致:同一 平台×账号 在「独立窗」与「应用内
 * 标签」两条路径要落进同一个 persist 分区,登录态才互通。
 */
export function sanitizeProfileSegment(raw: string): string | null {
  const segment = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (segment.length === 0 || segment.length > 64) return null;
  return segment;
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
