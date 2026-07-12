// 应用内「网页内容标签」运行时（2026-07-12 用户拍板：打开文章 / 网页里点开的
// 新内容，都以标签形式在当前工具内打开，绝不弹独立系统窗口）。
//
// 与「后台标签」(browser-panes)的区别：后台标签按 平台×账号 唯一(登录/发布用，
// 一账号一个)；网页内容标签按唯一 id 多开(读文章、点链接开的新页各自成标签)，
// 但复用同一 平台×账号 的登录分区(读全文不被登出墙挡)。
//
// 临时态：url/标题存内存注册表，不跨应用重启(阅读标签重启即弃，符合直觉)。
// 三方靠事件解耦：openWebTab(创作台/网页内弹窗) → WebTabsHost(常驻 webview 宿主)
// 与 WorkspaceTabsBar(标签栏)。
import { navigate } from '../router';
import { browserPanePartition } from './browser-panes';

export const OPEN_WEB_TAB_EVENT = 'od:web-tab:open';
export const WEB_TAB_CLOSED_EVENT = 'od:web-tab:closed';
export const WEB_TAB_UPDATED_EVENT = 'od:web-tab:updated';

export interface WebTabInfo {
  id: string;
  url: string;
  /** webview 分区(登录态)。 */
  partition: string;
  /** 工具条 chip / 标签标题用；缺省用 url host。 */
  platform?: string;
  account?: string;
  /** 页面 <title>，加载后回填(标签栏据此显示，缺省用 url host)。 */
  title?: string;
}

export interface OpenWebTabRequest {
  url: string;
  /** 显式分区(网页内弹窗从主进程带来的 partition)。 */
  partition?: string;
  /** 或平台×账号(创作台文章链接)——据此推导分区，登录态与后台标签互通。 */
  platform?: string;
  account?: string;
  title?: string;
}

/** 内存注册表：id → 标签信息。不持久化(重启即弃)。 */
const registry = new Map<string, WebTabInfo>();

function nextId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** url 的可读短标题(host + 路径首段)，用于标签在拿到真实 <title> 前的占位。 */
export function webTabLabelFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return raw.slice(0, 30);
  }
}

export function webTabInfo(id: string): WebTabInfo | undefined {
  return registry.get(id);
}

/** 打开(新建)一个应用内网页内容标签：注册 → 递宿主 → 路由切到该标签。 */
export function openWebTab(req: OpenWebTabRequest): string {
  const partition =
    req.partition ??
    (req.platform ? browserPanePartition(req.platform, req.account ?? 'main') : 'persist:od-browser-web-main');
  const id = nextId();
  const info: WebTabInfo = {
    id,
    url: req.url,
    partition,
    ...(req.platform ? { platform: req.platform } : {}),
    ...(req.account ? { account: req.account } : {}),
    ...(req.title ? { title: req.title } : {}),
  };
  registry.set(id, info);
  window.dispatchEvent(new CustomEvent<WebTabInfo>(OPEN_WEB_TAB_EVENT, { detail: info }));
  navigate({ kind: 'web', id });
  return id;
}

/** 标签关闭 → 销毁对应 webview(结束 keep-alive)并出注册表。 */
export function closeWebTab(id: string): void {
  registry.delete(id);
  window.dispatchEvent(new CustomEvent<{ id: string }>(WEB_TAB_CLOSED_EVENT, { detail: { id } }));
}

/** webview 拿到页面 <title> 后回填，标签栏据此刷新标题（截断，别让长标题撑爆）。 */
export function updateWebTabTitle(id: string, rawTitle: string): void {
  const info = registry.get(id);
  const title = rawTitle.trim().slice(0, 80);
  if (!info || !title || info.title === title) return;
  registry.set(id, { ...info, title });
  window.dispatchEvent(new CustomEvent<{ id: string }>(WEB_TAB_UPDATED_EVENT, { detail: { id } }));
}
