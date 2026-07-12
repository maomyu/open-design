// 应用内「网页内容标签」宿主（2026-07-12 用户拍板：打开文章 / 网页里点开的新页
// 都以标签在当前工具内打开，绝不弹独立系统窗口）。
//
// keep-alive：所有打开过的网页标签常驻，切走只改 visibility（<webview> 在
// display:none 下会分离 guest 白屏）。样式复用后台标签宿主（同款浏览器 chrome）。
// 与 BrowserPanesHost 的分工：那个是「一账号一后台」(登录/发布)，这个是「按 id
// 多开的内容标签」(读文章/点链接开新页)，两者并存互不干扰。
//
// 无「弹独立窗」按钮（用户明确不要独立窗）；关闭统一走标签栏的 X（closeTab →
// closeWebTab → 本宿主销毁对应 webview）。
import { useEffect, useRef, useState } from 'react';
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { Route } from '../router';
import { Icon } from './Icon';
import { BROWSER_PLATFORM_TITLES } from '../runtime/browser-panes';
import {
  OPEN_WEB_TAB_EVENT,
  WEB_TAB_CLOSED_EVENT,
  updateWebTabTitle,
  webTabLabelFromUrl,
  type WebTabInfo,
} from '../runtime/web-tabs';
import styles from './BrowserPanesHost.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** Electron <webview> 的导航 API 子集（web 包不依赖 electron 类型）。 */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getURL(): string;
  getTitle(): string;
}

export function WebTabsHost({ route }: { route: Route }): JSX.Element | null {
  const [tabs, setTabs] = useState<WebTabInfo[]>([]);
  const desktop = isOpenDesignHostBrowserAvailable();
  const activeId = route.kind === 'web' ? route.id : null;

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const info = (ev as CustomEvent<WebTabInfo>).detail;
      if (!info?.id || !info.url) return;
      setTabs((list) => (list.some((t) => t.id === info.id) ? list : [...list, info]));
    };
    const onClosed = (ev: Event) => {
      const id = (ev as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setTabs((list) => list.filter((t) => t.id !== id));
    };
    window.addEventListener(OPEN_WEB_TAB_EVENT, onOpen);
    window.addEventListener(WEB_TAB_CLOSED_EVENT, onClosed);
    return () => {
      window.removeEventListener(OPEN_WEB_TAB_EVENT, onOpen);
      window.removeEventListener(WEB_TAB_CLOSED_EVENT, onClosed);
    };
  }, []);

  // 网页端没有 <webview>：网页标签本就不该被创建（topicLinkOpener 在网页端返回
  // undefined），这里兜底不渲染。
  if (!desktop) return null;
  if (route.kind !== 'web' && tabs.length === 0) return null;

  return (
    <div
      className={`${c('host')}${activeId ? ` ${c('hostActive')}` : ''}`}
      aria-hidden={activeId ? undefined : true}
    >
      {tabs.map((tab) => (
        <WebTab key={tab.id} spec={tab} active={tab.id === activeId} />
      ))}
    </div>
  );
}

function WebTab({ spec, active }: { spec: WebTabInfo; active: boolean }): JSX.Element {
  const ref = useRef<WebviewElement | null>(null);
  const [nav, setNav] = useState({ url: spec.url, canBack: false, canFwd: false, loading: true });

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
    const onTitle = () => {
      try {
        updateWebTabTitle(spec.id, el.getTitle());
      } catch {
        /* 标题读取失败无所谓,标签栏回落 url host */
      }
    };
    el.addEventListener('did-navigate', sync);
    el.addEventListener('did-navigate-in-page', sync);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', sync);
    el.addEventListener('page-title-updated', onTitle);
    return () => {
      el.removeEventListener('did-navigate', sync);
      el.removeEventListener('did-navigate-in-page', sync);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', sync);
      el.removeEventListener('page-title-updated', onTitle);
    };
  }, [spec.id]);

  const label = spec.platform
    ? `${BROWSER_PLATFORM_TITLES[spec.platform] ?? spec.platform}${spec.account ? ` · ${spec.account}` : ''}`
    : webTabLabelFromUrl(spec.url);

  return (
    <div className={`${c('pane')}${active ? ` ${c('paneActive')}` : ''}`} aria-hidden={!active}>
      <div className={c('toolbar')}>
        <span className={c('profileChip')} title={spec.platform ? `登录态:${spec.platform} × ${spec.account ?? 'main'}` : spec.url}>
          {label}
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
      </div>
      <webview
        ref={(el) => {
          ref.current = el as unknown as WebviewElement | null;
        }}
        className={c('webview')}
        src={spec.url}
        partition={spec.partition}
        // 见 BrowserPanesHost:react-dom 要求字符串,Electron 只看属性存在与否。
        allowpopups={'true' as unknown as boolean}
      />
    </div>
  );
}
