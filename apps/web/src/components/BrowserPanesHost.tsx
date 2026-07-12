// 应用内后台标签页宿主（2026-07-09 用户拍板:后台在主窗口内打开,像浏览器
// 标签一样与创作台并列切换）。
//
// 丝滑的关键是 keep-alive:本组件常驻 workspace-shell__body,所有打开过的
// 后台面板保持挂载,切走只改 visibility(绝不 display:none —— Electron
// <webview> 在 display:none 下会分离 guest 导致白屏),切回零重载,登录态、
// 滚动位置、后台里写了一半的内容全保持。
//
// 安全:webview 无 preload、无 node,分区固定 persist:od-browser-<平台>-<账号>,
// 主进程 hardenWebviewEmbeddedBrowser 白名单校验 + 会话级干净 UA。
// 非桌面端(host 桥不可用)渲染降级卡片,走独立 Chrome 档案的老路径。
import { useEffect, useRef, useState } from 'react';
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { Route } from '../router';
import { Icon } from './Icon';
import {
  completeHandoffJob,
  openStudioBrowserWindow,
  reportHandoffProgress,
  resolvePlatformBrowserUrl,
} from '../providers/media-studio';
import {
  BROWSER_PLATFORM_TITLES,
  BROWSER_TAB_CLOSED_EVENT,
  OPEN_BROWSER_PANE_EVENT,
  browserPaneKey,
  browserPanePartition,
  type BrowserPaneRequest,
  type CollectPaneSpec,
} from '../runtime/browser-panes';
import { runDraftInjection, type DraftPayload, type DraftWebview } from '../runtime/browser-draft';
import { EXTRACTORS, INFINITE_SCROLL, LOGIN_WALL, buildSearchUrl } from '../runtime/collect-extractors';
import { postCollectResult, reportCollectProgress } from '../providers/media-studio';
import type { StudioCollectItem } from '@open-design/contracts';
import styles from './BrowserPanesHost.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/**
 * 在当前面板 webview 里采集一个平台的搜索结果（含翻页/时间窗），回写采集 job。
 * 流程：逐页(或滚动)导航搜索页(带排序+时间窗参数) → 判登录墙 → 抓卡片 → 去重累积 →
 * postCollectResult。全程只在本标签里跑，不弹独立窗口。
 */
async function runCollect(
  el: DraftWebview | null,
  spec: CollectPaneSpec,
  isCancelled: () => boolean,
): Promise<void> {
  const { jobId, platform } = spec;
  const done = (items: StudioCollectItem[], needsLogin: boolean, note: string) => {
    if (isCancelled()) return;
    postCollectResult(jobId, [{ platform, items, needsLogin, ...(note ? { note } : {}) }]);
  };
  if (!el) return done([], false, '面板 webview 未就绪');
  const evalJs = async (js: string, timeoutMs = 4000): Promise<unknown> => {
    try {
      return await Promise.race([
        el.executeJavaScript(js),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
    } catch {
      return undefined;
    }
  };
  const waitReady = async () => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const state = await evalJs('document.readyState', 2000);
      if (state === 'complete' || state === 'interactive') break;
      await new Promise((r) => setTimeout(r, 800));
      if (isCancelled()) return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  };

  const infinite = INFINITE_SCROLL[platform];
  const pages = infinite ? 1 : Math.max(1, spec.pages);
  const byId = new Map<string, StudioCollectItem>();
  let loginWalled = false;

  for (let page = 1; page <= pages; page++) {
    if (isCancelled()) return;
    const url = buildSearchUrl(platform, spec.keyword, {
      order: spec.order, timeWindow: spec.timeWindow, page, nowSec: spec.nowSec,
    });
    reportCollectProgress(jobId, `「${platform}」第 ${page} 页，加载中…`);
    await evalJs(`location.href = ${JSON.stringify(url)}`, 4000);
    await waitReady();
    if (isCancelled()) return;
    // 登录墙判定（首页判一次即可）
    if (page === 1) {
      const bodyText = (await evalJs('document.body ? document.body.innerText.slice(0,4000) : ""')) as string | undefined;
      const signals = LOGIN_WALL[platform] ?? [];
      if (typeof bodyText === 'string' && signals.some((s) => bodyText.includes(s))) {
        reportCollectProgress(jobId, `「${platform}」需要登录——请在这个标签里扫码登录后重试`);
        loginWalled = true;
        break;
      }
    }
    // 无限滚动平台：滚动触发懒加载
    if (infinite) {
      for (let i = 0; i < Math.max(0, spec.scrolls); i++) {
        await evalJs('window.scrollBy(0, 2000)', 2000);
        await new Promise((r) => setTimeout(r, 1200));
        if (isCancelled()) return;
      }
    }
    const raw = await evalJs(EXTRACTORS[platform], 8000);
    for (const it of Array.isArray(raw) ? raw : []) {
      const item = { ...(it as Record<string, unknown>), platform } as StudioCollectItem;
      const key = String(item.content_id ?? item.url ?? Math.random());
      if (!byId.has(key)) byId.set(key, item);
    }
    reportCollectProgress(jobId, `「${platform}」第 ${page} 页累计 ${byId.size} 条`);
    if (byId.size >= spec.per) break;
  }

  if (loginWalled) return done([], true, '需要登录：请在标签里扫码登录后重跑采集');
  const items = [...byId.values()].slice(0, spec.per);
  reportCollectProgress(jobId, `「${platform}」采到 ${items.length} 条`);
  done(items, false, items.length ? '' : '未提取到条目(选择器需校准或结果未加载)');
}

interface PaneSpec {
  key: string;
  platform: string;
  account: string;
  url: string;
  /** 「一键存草稿」载荷:面板就绪后消费一次,seq 递增触发重新注入。 */
  draft?: DraftPayload;
  draftSeq?: number;
  /** handoff 桥 job id(CLI 派发):注入进度/终态回写 daemon。 */
  draftJobId?: string;
  /** 爆款雷达采集载荷:面板就绪后消费一次,seq 递增触发重新采集。 */
  collect?: CollectPaneSpec;
  collectSeq?: number;
}

/** Electron <webview> 的导航 API 子集（web 包不依赖 electron 类型）。 */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getURL(): string;
}

export function BrowserPanesHost({ route }: { route: Route }): JSX.Element | null {
  const [panes, setPanes] = useState<PaneSpec[]>([]);
  const desktop = isOpenDesignHostBrowserAvailable();
  const activeKey = route.kind === 'browser' ? browserPaneKey(route.platform, route.account) : null;

  // openStudioBrowser 桌面路径递来的 pane 规格。
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const req = (ev as CustomEvent<BrowserPaneRequest>).detail;
      if (!req?.platform || !req.url) return;
      setPanes((list) => {
        const key = browserPaneKey(req.platform, req.account);
        const existing = list.find((p) => p.key === key);
        if (existing) {
          // 已有面板:带 draft/collect 再次打开=对同一面板重跑(seq 递增触发)。
          if (req.collect) {
            return list.map((p) =>
              p.key === key
                ? { ...p, url: req.url, collect: req.collect!, collectSeq: (p.collectSeq ?? 0) + 1 }
                : p,
            );
          }
          if (!req.draft) return list;
          return list.map((p) =>
            p.key === key
              ? { ...p, draft: req.draft!, draftSeq: (p.draftSeq ?? 0) + 1, draftJobId: req.draftJobId }
              : p,
          );
        }
        return [
          ...list,
          {
            key,
            platform: req.platform,
            account: req.account,
            url: req.url,
            ...(req.draft ? { draft: req.draft, draftSeq: 1 } : {}),
            ...(req.draftJobId ? { draftJobId: req.draftJobId } : {}),
            ...(req.collect ? { collect: req.collect, collectSeq: 1 } : {}),
          },
        ];
      });
    };
    const onClosed = (ev: Event) => {
      const { platform, account } = (ev as CustomEvent<{ platform: string; account: string }>).detail ?? {};
      if (!platform) return;
      const key = browserPaneKey(platform, account ?? '');
      setPanes((list) => list.filter((p) => p.key !== key));
    };
    window.addEventListener(OPEN_BROWSER_PANE_EVENT, onOpen);
    window.addEventListener(BROWSER_TAB_CLOSED_EVENT, onClosed);
    return () => {
      window.removeEventListener(OPEN_BROWSER_PANE_EVENT, onOpen);
      window.removeEventListener(BROWSER_TAB_CLOSED_EVENT, onClosed);
    };
  }, []);

  // 兜底:应用重启后 revive 出的后台标签没有 pane(URL 未知),点开时按平台
  // 默认后台地址补建。
  useEffect(() => {
    if (route.kind !== 'browser' || !desktop) return;
    const key = browserPaneKey(route.platform, route.account);
    if (panes.some((p) => p.key === key)) return;
    let cancelled = false;
    void resolvePlatformBrowserUrl(route.platform).then((url) => {
      if (cancelled || !url) return;
      setPanes((list) =>
        list.some((p) => p.key === key)
          ? list
          : [...list, { key, platform: route.platform, account: route.account, url }],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [route, desktop, panes]);

  if (route.kind !== 'browser' && panes.length === 0) return null;

  if (!desktop) {
    // 网页版没有 <webview>:占位说明 + 独立档案浏览器逃生口。
    if (route.kind !== 'browser') return null;
    return (
      <div className={`${c('host')} ${c('hostActive')}`}>
        <div className={c('fallback')}>
          <p>网页版不支持在应用内嵌入平台后台。</p>
          <button
            type="button"
            className={c('fallbackBtn')}
            onClick={() => void openStudioBrowserWindow({ platform: route.platform, account: route.account })}
          >
            用独立浏览器档案打开
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${c('host')}${activeKey ? ` ${c('hostActive')}` : ''}`}
      aria-hidden={activeKey ? undefined : true}
    >
      {panes.map((pane) => (
        <BrowserPane key={pane.key} spec={pane} active={pane.key === activeKey} />
      ))}
    </div>
  );
}

function BrowserPane({ spec, active }: { spec: PaneSpec; active: boolean }): JSX.Element {
  const ref = useRef<WebviewElement | null>(null);
  const [nav, setNav] = useState({ url: spec.url, canBack: false, canFwd: false, loading: true });
  // 「一键存草稿」注入状态:idle → running(进度文案) → done/fail(结果)。
  const [draftState, setDraftState] = useState<{ phase: 'idle' | 'running' | 'done' | 'fail'; text: string }>({
    phase: 'idle',
    text: '',
  });
  const ranSeqRef = useRef(0);

  useEffect(() => {
    const seq = spec.draftSeq ?? 0;
    if (!spec.draft || seq === 0 || seq === ranSeqRef.current) return;
    const draft = spec.draft;
    // handoff 桥(CLI 派发)时进度/终态同步回写 daemon;UI 按钮路径 jobId 为空。
    const jobId = spec.draftJobId;
    let started = false;
    let cancelled = false;
    // 延迟 400ms 才真正启动:React StrictMode(dev)会挂载→清理→重挂,
    // 假挂载的定时器被 cleanup 清掉,注入只在真挂载跑一次(否则图片
    // 会被传两遍)。
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      ranSeqRef.current = seq;
      void run();
    }, 400);
    async function run() {
      const el = ref.current as unknown as DraftWebview | null;
      if (!el) {
        if (jobId) completeHandoffJob(jobId, false, '面板 webview 未就绪——重试一次 handoff');
        return;
      }
      started = true;
      setDraftState({ phase: 'running', text: '等页面加载…' });
      if (jobId) reportHandoffProgress(jobId, '面板已开,等页面加载…');
      // 面板可能停在上次「暂存离开」跳转后的页面——注入前先导回发布页,
      // 否则第一步(切图文 tab/找上传框)就落空。
      try {
        const cur = el.getURL();
        const wantPath = spec.url.split('?')[0] ?? spec.url;
        if (wantPath && !cur.startsWith(wantPath)) {
          await el.executeJavaScript(`location.href = ${JSON.stringify(spec.url)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch {
        /* 导航失败继续走加载等待,引擎内部有兜底 */
      }
      if (cancelled) return;
      // 等 webview 加载完。注意:加载中 executeJavaScript 可能挂起不返回,
      // 必须超时竞速推进,30s 上限后强行进入注入(引擎内部每步也有兜底)。
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const state = (await Promise.race([
            el.executeJavaScript('document.readyState'),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ])) as string;
          if (state === 'complete' || state === 'interactive') break;
        } catch {
          /* webview 尚未就绪/挂起 */
        }
        await new Promise((r) => setTimeout(r, 800));
        if (cancelled) return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled) return;
      const result = await runDraftInjection(el, draft, (msg) => {
        if (!cancelled) setDraftState({ phase: 'running', text: msg });
        if (jobId) reportHandoffProgress(jobId, msg);
      });
      if (!cancelled) setDraftState({ phase: result.ok ? 'done' : 'fail', text: result.detail });
      if (jobId) completeHandoffJob(jobId, result.ok, result.detail);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      // 已经在跑的注入被打断(热更/关面板)时绝不能让进度条永远转圈——
      // 置为可操作的终态,重点一次「一键存草稿」即可。CLI 派发的 job 同步
      // 收尾,别让 od 那头长轮询干等到 TTL。
      if (started && jobId) {
        completeHandoffJob(jobId, false, '注入被打断(面板关闭/应用热更)——重试一次 handoff');
      }
      setDraftState((s) =>
        s.phase === 'running'
          ? { phase: 'fail', text: '自动填稿被打断——回发布步再点一次「一键存草稿」即可' }
          : s,
      );
    };
  }, [spec.draft, spec.draftSeq]);

  // 爆款雷达采集:面板加载后在【本标签 webview】里滚动+抓卡片，回写采集 job。
  const ranCollectRef = useRef(0);
  useEffect(() => {
    const seq = spec.collectSeq ?? 0;
    if (!spec.collect || seq === 0 || seq === ranCollectRef.current) return;
    const collect = spec.collect;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      ranCollectRef.current = seq;
      void runCollect(ref.current as unknown as DraftWebview | null, collect, () => cancelled);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [spec.collect, spec.collectSeq]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      try {
        setNav({ url: el.getURL(), canBack: el.canGoBack(), canFwd: el.canGoForward(), loading: false });
      } catch {
        /* webview 尚未就绪时读导航状态会抛,下一个事件再同步 */
      }
    };
    const onStart = () => setNav((n) => ({ ...n, loading: true }));
    el.addEventListener('did-navigate', sync);
    el.addEventListener('did-navigate-in-page', sync);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', sync);
    return () => {
      el.removeEventListener('did-navigate', sync);
      el.removeEventListener('did-navigate-in-page', sync);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', sync);
    };
  }, []);

  const platformLabel = BROWSER_PLATFORM_TITLES[spec.platform] ?? spec.platform;

  return (
    <div className={`${c('pane')}${active ? ` ${c('paneActive')}` : ''}`} aria-hidden={!active}>
      <div className={c('toolbar')}>
        <span className={c('profileChip')} title={`档案隔离:${spec.platform} × ${spec.account}`}>
          {platformLabel} · {spec.account}
        </span>
        <button
          type="button"
          className={c('navBtn')}
          disabled={!nav.canBack}
          title="后退"
          onClick={() => ref.current?.goBack()}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className={c('navBtn')}
          disabled={!nav.canFwd}
          title="前进"
          onClick={() => ref.current?.goForward()}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className={c('navBtn')} title="刷新" onClick={() => ref.current?.reload()}>
          <Icon name={nav.loading ? 'spinner' : 'refresh'} size={13} />
        </button>
        <span className={c('urlBox')} title={nav.url}>
          {nav.url}
        </span>
        <button
          type="button"
          className={c('navBtn')}
          title="弹出为独立窗口（双屏对照时用;同一档案,登录态互通）"
          onClick={() => void openStudioBrowserWindow({ platform: spec.platform, account: spec.account, url: nav.url })}
        >
          <Icon name="external-link" size={13} />
        </button>
      </div>
      {draftState.phase !== 'idle' ? (
        <div
          className={`${c('draftBar')}${draftState.phase === 'done' ? ` ${c('draftBarOk')}` : ''}${draftState.phase === 'fail' ? ` ${c('draftBarFail')}` : ''}`}
        >
          {draftState.phase === 'running' ? <Icon name="spinner" size={13} /> : null}
          <span>{draftState.phase === 'running' ? `自动填稿:${draftState.text}` : draftState.text}</span>
          {draftState.phase !== 'running' ? (
            <button type="button" className={c('draftBarClose')} onClick={() => setDraftState({ phase: 'idle', text: '' })}>
              <Icon name="close" size={11} />
            </button>
          ) : null}
        </div>
      ) : null}
      <webview
        ref={(el) => {
          ref.current = el as unknown as WebviewElement | null;
        }}
        className={c('webview')}
        src={spec.url}
        partition={browserPanePartition(spec.platform, spec.account)}
        // React 类型库把 allowpopups 声明成 boolean,但 react-dom 运行时把它
        // 当未知属性、布尔值会告警——必须传字符串;Electron 只看属性存在与否。
        allowpopups={'true' as unknown as boolean}
      />
    </div>
  );
}
