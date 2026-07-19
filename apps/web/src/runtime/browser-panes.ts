// 应用内后台标签页的共享运行时（2026-07-09 用户拍板:后台在主窗口内打开）。
// providers(openStudioBrowser 桌面路径)、WorkspaceTabsBar(关标签)与
// BrowserPanesHost(常驻面板宿主)三方靠这里的事件与工具函数解耦。
import { navigate } from '../router';
import type { DraftPayload } from './browser-draft';
import type { StudioCollectPlatform } from '@open-design/contracts';

export const OPEN_BROWSER_PANE_EVENT = 'od:browser-pane:open';
export const BROWSER_TAB_CLOSED_EVENT = 'od:browser-pane:closed';
export const GRAB_VIDEO_RESULT_EVENT = 'od:browser-pane:grab-result';

/** 爆款雷达采集载荷:面板加载后在标签里翻页/滚动+抓卡片，回写 daemon 采集 job。 */
export interface CollectPaneSpec {
  jobId: string;
  platform: StudioCollectPlatform;
  keyword: string;
  scrolls: number;
  per: number;
  order: 'hot' | 'latest' | 'comprehensive';
  timeWindow: string;
  pages: number;
  /** 时间窗起点基准（秒）；由 daemon/listener 传入，webview 侧不再取当前时间。 */
  nowSec: number;
}

/** 读评论载荷:面板导航到笔记页后跑评论树提取器,回写 daemon read-comments job(一次性)。 */
export interface CommentReadPaneSpec {
  jobId: string;
  platform: string;
  noteRef: string;
}

/** 互动执行载荷:面板打开目标页后做自动评论回复/楼中楼(拟人输入发送),回写 daemon interaction job。 */
export interface InteractPaneSpec {
  jobId: string;
  platform: string;
  action: 'reply' | 'sub-reply' | 'dm';
  targetRef: string;
  /** 楼中楼:要打开的笔记 URL(targetRef 为父评论 id)。 */
  noteRef?: string;
  text: string;
}

/** 登录态探测载荷:面板打开平台主站后判「这个账号还登录着吗」,回写 daemon login-check job。 */
export interface LoginCheckPaneSpec {
  jobId: string;
  platform: string;
  account: string;
}

export interface BrowserPaneRequest {
  platform: string;
  account: string;
  url: string;
  /** 「一键存草稿」:面板加载完成后自动执行的填稿载荷(一次性)。 */
  draft?: DraftPayload;
  /** handoff 桥 job id(CLI 派发):注入进度/终态回写 daemon。 */
  draftJobId?: string;
  /** 爆款雷达采集:面板加载后在标签里抓真实爆款卡片(一次性)。 */
  collect?: CollectPaneSpec;
  /** 读评论:面板导航到笔记页后抓评论树(一次性)。 */
  readComments?: CommentReadPaneSpec;
  /** 互动执行:面板打开目标页后做自动评论回复/楼中楼(一次性)。 */
  interact?: InteractPaneSpec;
  /** 登录态探测:面板打开平台主站后判登录态,回写 login-check job(一次性)。 */
  loginCheck?: LoginCheckPaneSpec;
  /** 「边播边抓」下载:面板导航到 url(视频页)、抓 <video> 直链后回报(一次性)。 */
  grab?: { grabId: string };
}

/** 「边播边抓」:在内置浏览器(已登录会话)打开视频页,抓到媒体直链 + referer。
 *  用于 yt-dlp 下不了(需登录/反爬)的抖音/小红书/快手。返回 {mediaUrl,referer} 或 {error}。 */
export function grabVideoSrc(req: { platform: string; account: string; url: string }):
  Promise<{ mediaUrl: string; referer: string } | { error: string }> {
  const grabId = `grab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return new Promise((resolve) => {
    const onResult = (ev: Event) => {
      const d = (ev as CustomEvent<{ grabId: string; result: { mediaUrl: string; referer: string } | { error: string } }>).detail;
      if (!d || d.grabId !== grabId) return;
      window.removeEventListener(GRAB_VIDEO_RESULT_EVENT, onResult);
      clearTimeout(timer);
      resolve(d.result);
    };
    const timer = setTimeout(() => {
      window.removeEventListener(GRAB_VIDEO_RESULT_EVENT, onResult);
      resolve({ error: '抓取超时——视频可能是加密流,或未在页面加载出来' });
    }, 90_000);
    window.addEventListener(GRAB_VIDEO_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent<BrowserPaneRequest>(OPEN_BROWSER_PANE_EVENT, {
      detail: { platform: req.platform, account: req.account, url: req.url, grab: { grabId } },
    }));
    navigate({ kind: 'browser', platform: req.platform, account: req.account });
  });
}

/**
 * 导出该 平台×账号 登录分区的 cookie 到本机文件(给 daemon 的 yt-dlp 带真实
 * 会话)。抖音/小红书的视频下载接口现在硬性要 cookie——用户已在内置浏览器登录,
 * 这里把登录态落成 Netscape 文件,下载器加 --cookies 就能像登录用户一样下原视频。
 * 仅桌面端可用(需主进程 session.cookies);Web-only 环境返回 null,调用方回退。
 */
export async function exportBrowserCookies(platform: string, account: string): Promise<string | null> {
  try {
    const host = (globalThis as Record<string, unknown>)['__od__'] as
      | { browser?: { exportCookies?: (r: { platform: string; account: string }) => Promise<unknown> } }
      | undefined;
    const fn = host?.browser?.exportCookies;
    if (typeof fn !== 'function') return null;
    // 加超时兜底:cookie 导出是 IPC 调用,若浏览器分区未就绪/主进程卡住,await 会永久挂起——
    // 而下载首选走 TikHub 直链本就不需要 cookie。6s 拿不到就当没有(返回 null),让下载照常进行,
    // 避免"提取仿写"卡在①下载前(用户报"一直转圈"的根因之一)。
    const res = await Promise.race([
      fn({ platform: normalizeBrowserPlatform(platform), account }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    if (res && typeof res === 'object' && (res as { ok?: boolean }).ok === true) {
      const cf = (res as { cookieFile?: string }).cookieFile;
      return typeof cf === 'string' && cf ? cf : null;
    }
    return null;
  } catch {
    return null;
  }
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
  weibo: '微博',
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
