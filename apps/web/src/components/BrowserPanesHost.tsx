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
import { navigate, type Route } from '../router';
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
  GRAB_VIDEO_RESULT_EVENT,
  OPEN_BROWSER_PANE_EVENT,
  browserPaneKey,
  browserPanePartition,
  type BrowserPaneRequest,
  type CollectPaneSpec,
  type CommentReadPaneSpec,
  type InteractPaneSpec,
  type LoginCheckPaneSpec,
} from '../runtime/browser-panes';
import { runDraftInjection, humanSearch, type DraftPayload, type DraftWebview } from '../runtime/browser-draft';
import { runReplyInjection } from '../runtime/reply-injectors';
import { CARD_PROBE_SEL, EXTRACTORS, INFINITE_SCROLL, LOGIN_WALL, PLATFORM_HOMEPAGE, SEARCH_BY_TYPING, buildSearchUrl } from '../runtime/collect-extractors';
import { COMMENT_EXTRACTORS, COMMENT_LOGIN_WALL, buildNoteUrl, type CommentPlatform } from '../runtime/comment-extractors';
import { LOGIN_HOME, LOGIN_PROBE, parseLoginProbe } from '../runtime/login-markers';
import { postCollectResult, reportCollectProgress, postCommentReadResult, reportCommentReadProgress, reportInteractionProgress, completeInteractionJob, reportLoginCheckProgress, postLoginCheckResult, completeLoginCheckJob } from '../providers/media-studio';
import type { CommentNode, StudioCollectItem } from '@open-design/contracts';
import styles from './BrowserPanesHost.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/**
 * 在当前面板 webview 里采集一个平台的搜索结果（含翻页/时间窗），回写采集 job。
 * 流程：逐页(或滚动)导航搜索页(带排序+时间窗参数) → 判登录墙 → 抓卡片 → 去重累积 →
 * postCollectResult。全程只在本标签里跑，不弹独立窗口。
 */
// 采集【串行队列】：多平台同时选中时各平台面板会各自触发采集。4 个重 webview(尤其抖音/
// 小红书 SPA + 首页暖场)并行加载会互抢 CPU/渲染资源,导致每轮总有一个重平台在重试预算内
// 没渲染出结果=0 条(非确定性打地鼠)。改为排队一次只跑一个平台,各拿满资源→稳定。
// (前提:面板副作用已只依赖 collectSeq,重渲染不再误取消排队中的任务。)
let collectQueue: Promise<unknown> = Promise.resolve();
function enqueueCollect(task: () => Promise<void>): Promise<void> {
  const next = collectQueue.then(task, task);
  collectQueue = next.catch(() => {});
  return next;
}

// 采集期在【浏览器标签本身】上显示的醒目状态(验证码/需登录时用户正看着这个标签)。
export type CollectPaneStatus = { text: string; kind: 'info' | 'action' | 'done' } | null;

async function runCollect(
  el: DraftWebview | null,
  spec: CollectPaneSpec,
  isCancelled: () => boolean,
  onStatus?: (s: CollectPaneStatus) => void,
): Promise<void> {
  const { jobId, platform } = spec;
  const say = (text: string, kind: 'info' | 'action' | 'done') => {
    if (!isCancelled()) onStatus?.({ text, kind });
  };
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

  // 反爬验证码检测。踩过两个坑,现在的口径是【只认真正弹出可见的验证弹层】:
  //   - 2026-07-14 先漏报(旧版只查正文前 900 字,抖音验证码在 iframe 里读不到);
  //   - 改宽后又误报(用户报"提示了但根本没要验证"):抖音页面为随时能弹验证【常驻一个隐藏的
  //     captcha 容器】,加上正文里"验证码登录"等字样,宽泛匹配(正文关键词 / [class*=captcha] /
  //     iframe[src*=verify])把这些没弹出的东西也当成了正在验证。
  // 定稿:不看正文关键词、不用宽泛通配;只认【字节系精确验证容器 / 验证 iframe】且【当前可见、
  // 尺寸够大】(排除 display:none、0 尺寸、移出视口的常驻隐藏容器)。宁可偶尔漏报(顶多采不到、
  // 有"未提取到"提示),也不要误报把用户支使去看根本不存在的验证。
  const detectCaptcha = async (): Promise<boolean> => {
    const hit = await evalJs(
      `(() => { try {
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 120) return false;          // 常驻隐藏容器/小图标:太小,排除
          if (r.right < 0 || r.bottom < 0 || r.left > innerWidth) return false; // 移出视口(left:-9999 等)
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0;
        };
        // 字节系(抖音/头条)验证码专用容器 —— 平时不注入或隐藏,真弹出时才可见。精确 class。
        const sels = ['.captcha_verify_container', '[class*="captcha_verify"]', '.secsdk-captcha-drag-wrapper', '#captcha-verify-image', '#captcha_container'];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) { if (vis(el)) return true; }
        }
        // 可见且够大的验证 iframe(内容跨源读不到,但元素可见性/尺寸能判)。src 必须明确带 captcha/secsdk。
        for (const f of document.querySelectorAll('iframe')) {
          if (/captcha|secsdk/i.test(f.getAttribute('src') || '') && vis(f)) return true;
        }
        return false;
      } catch (e) { return false; } })()`,
      3000,
    );
    return hit === true;
  };
  // 撞验证码 → 前台红条醒目提示 + 等用户过(最多 4 分钟)→ 过了重进搜索页继续。
  const waitOutCaptcha = async (search: string): Promise<'passed' | 'timeout' | 'cancelled'> => {
    reportCollectProgress(jobId, `「${platform}」平台弹了验证码——浏览器已在前台,请完成验证(拖拽/选图/滑块),我会一直等你,过完自动继续采集`);
    say('⚠️ 平台要求验证:请在下方浏览器里完成验证(拖拽/滑块/选图),完成后自动继续采集(我会一直等你)', 'action');
    const deadline = Date.now() + 4 * 60_000; // 给足 4 分钟人工过验证
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (isCancelled()) return 'cancelled';
      // 验证码 DOM/文案都消失即算过——不强绑结果卡片(抖音过验证后常先跳回搜索/推荐页,卡片还没出)。
      if (!(await detectCaptcha())) {
        reportCollectProgress(jobId, `「${platform}」验证码已过,重新进入搜索页继续采集…`);
        say('✓ 验证已过,继续采集…', 'info');
        await evalJs(`location.href = ${JSON.stringify(search)}`, 4000);
        await waitReady();
        return 'passed';
      }
    }
    reportCollectProgress(jobId, `「${platform}」验证等待超时,仍尝试抓取(可能没有结果)…`);
    return 'timeout';
  };

  const homepage = PLATFORM_HOMEPAGE[platform];
  const typeSearch = SEARCH_BY_TYPING[platform];
  for (let page = 1; page <= pages; page++) {
    if (isCancelled()) return;
    const searchUrl = buildSearchUrl(platform, spec.keyword, {
      order: spec.order, timeWindow: spec.timeWindow, page, nowSec: spec.nowSec,
    });
    if (page === 1 && typeSearch) {
      // 【真·模拟人输入】首页(抖音/小红书;快手无首页则退回搜索页)进 → 搜索框逐字符敲入 → 回车。
      const startUrl = homepage ?? searchUrl;
      reportCollectProgress(jobId, `「${platform}」打开${homepage ? '首页' : '搜索页'},准备像人一样输入…`);
      await evalJs(`location.href = ${JSON.stringify(startUrl)}`, 4000);
      await waitReady();
      if (isCancelled()) return;
      await new Promise((r) => setTimeout(r, 2200 + Math.floor(Math.random() * 1500))); // 等首页 feed 加载完 + 像人先看一眼
      reportCollectProgress(jobId, `「${platform}」真人式操作:先看两眼→真鼠标点搜索框→慢速逐字敲「${spec.keyword}」→回车(躲验证码)…`);
      // 真人模拟:真鼠标点框 + 系统级真实键入(isTrusted=true),取代 JS 合成事件——
      // 后者被抖音/小红书反爬识破必弹验证码。找不到框(no-input)就靠后面直连搜索页兜底。
      const searched = el ? await humanSearch(el, spec.keyword) : 'no-input';
      if (searched === 'no-input') {
        reportCollectProgress(jobId, `「${platform}」没找到搜索框,改直连搜索结果页…`);
      }
      await new Promise((r) => setTimeout(r, 2500)); // 等真实回车触发的搜索导航完成
      if (isCancelled()) return;
      // 真人打字+回车后【优先停在真人搜出来的结果页】。原来无条件硬跳规范搜索 URL——但硬跳
      // 深链本身是强机器人信号(抖音"总弹验证码"的诱因)。所以改成:先探一下真人结果页有没有
      // 卡片,有就留着(最像真人);只有解析不到(如落到抖音 jingxuan 变体页)才兜底硬跳规范
      // 搜索页保证提取器能抓。no-input(没找到搜索框)也走兜底硬跳。
      if (homepage) {
        const probe = (await evalJs(`document.querySelectorAll(${JSON.stringify(CARD_PROBE_SEL)}).length`, 3000)) as number | undefined;
        if (searched === 'no-input' || !(typeof probe === 'number' && probe > 0)) {
          reportCollectProgress(jobId, `「${platform}」真人结果页未见卡片,兜底进规范搜索页…`);
          await evalJs(`location.href = ${JSON.stringify(searchUrl)}`, 4000);
          await waitReady();
        } else {
          reportCollectProgress(jobId, `「${platform}」已停在真人搜索结果页(${probe} 张卡片)`);
        }
      }
    } else {
      // 直连平台(B站)或翻页:带排序/时间窗参数直接进搜索页。
      reportCollectProgress(jobId, `「${platform}」第 ${page} 页，加载中…`);
      await evalJs(`location.href = ${JSON.stringify(searchUrl)}`, 4000);
      await waitReady();
    }
    if (isCancelled()) return;
    // 登录墙判定（首页判一次即可）。需求:未登录时【停在前台等用户登录】,而不是直接
    // 失败让用户重跑——浏览器标签已在前台,轮询到登录墙消失即自动继续采集(和验证码一致)。
    if (page === 1) {
      const signals = LOGIN_WALL[platform] ?? [];
      const isWalled = async () => {
        const t = (await evalJs('document.body ? document.body.innerText.slice(0,4000) : ""', 3000)) as string | undefined;
        return typeof t === 'string' && signals.some((s) => t.includes(s));
      };
      if (signals.length && (await isWalled())) {
        const msg = `「${platform}」需要登录——浏览器已在前台,请扫码/登录,我会一直等你,登录后自动继续采集`;
        reportCollectProgress(jobId, msg);
        say('⚠️ 需要登录:请在下方浏览器里扫码/登录,登录后自动继续采集(我会一直等)', 'action');
        const deadline = Date.now() + 5 * 60_000; // 给足 5 分钟人工登录
        let loggedIn = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          if (isCancelled()) return;
          if (!(await isWalled())) { loggedIn = true; break; }
        }
        if (!loggedIn) { loginWalled = true; break; } // 超时仍未登录 → 老兜底(报需登录)
        // 登录后页面常已跳走,重新进规范搜索页再继续抓。
        reportCollectProgress(jobId, `「${platform}」已登录 ✓ 重新进入搜索页继续采集…`);
        say('✓ 已登录,继续采集…', 'info');
        await evalJs(`location.href = ${JSON.stringify(searchUrl)}`, 4000);
        await waitReady();
        if (isCancelled()) return;
      }
    }
    // 验证码判定：抖音/小红书反爬可能弹验证码(拖拽/滑块/选图)。检测到就【停在前台等用户过】,
    // 不快速失败跳走——这才是用户看到"窗口一闪就关、没爆款"的根因。过完验证码 + 出结果再继续。
    if (page === 1 && (await detectCaptcha())) {
      if ((await waitOutCaptcha(searchUrl)) === 'cancelled') return;
      if (isCancelled()) return;
    }
    // 无限滚动平台：滚动触发懒加载
    if (infinite) {
      for (let i = 0; i < Math.max(0, spec.scrolls); i++) {
        await evalJs('window.scrollBy(0, 2000)', 2000);
        await new Promise((r) => setTimeout(r, 1200));
        if (isCancelled()) return;
      }
    }
    // 提取：搜索结果常异步懒加载(抖音尤其慢,且 4 平台并行采集时被资源竞争进一步拖慢,
    // 结果晚于滚动才渲染)。提取到空就再滚再等重试,命中即停 —— 避免"提取太早=0 条"。
    // 命中即 break,所以快平台(B站/快手/小红书)首次即出、几乎不多等;只有慢平台会用满预算。
    let raw: unknown = await evalJs(EXTRACTORS[platform], 8000);
    for (let attempt = 0; attempt < 20 && !(Array.isArray(raw) && raw.length > 0); attempt++) {
      if (isCancelled()) return;
      // 验证码常在【搜索请求返回后 / 滚动触发风控时】才弹,不只在首帧——所以空转几次仍无结果时
      // 复检一次验证码(抖音尤甚),撞上就停下红条提示等用户过,而不是空转到超时=0 条还不吭声。
      if ((attempt === 2 || attempt === 6) && (await detectCaptcha())) {
        if ((await waitOutCaptcha(searchUrl)) === 'cancelled') return;
      }
      reportCollectProgress(jobId, `「${platform}」结果加载中,再等等…(第 ${attempt + 1} 次)`);
      await evalJs('window.scrollBy(0, 1200)', 2000);
      await new Promise((r) => setTimeout(r, 2500));
      raw = await evalJs(EXTRACTORS[platform], 8000);
    }
    for (const it of Array.isArray(raw) ? raw : []) {
      const item = { ...(it as Record<string, unknown>), platform } as StudioCollectItem;
      const key = String(item.content_id ?? item.url ?? Math.random());
      if (!byId.has(key)) byId.set(key, item);
    }
    reportCollectProgress(jobId, `「${platform}」第 ${page} 页累计 ${byId.size} 条`);
    if (byId.size >= spec.per) break;
  }

  if (loginWalled) {
    say('需要登录:请在浏览器里扫码登录后,回选题页重跑「真抓爆款」', 'action');
    return done([], true, '需要登录：请在标签里扫码登录后重跑采集');
  }
  const items = [...byId.values()].slice(0, spec.per);
  reportCollectProgress(jobId, `「${platform}」采到 ${items.length} 条`);
  say(items.length ? `✓ 「${platform}」采到 ${items.length} 条,正在评分…` : '未提取到条目,可换关键词或稍后重试', items.length ? 'done' : 'action');
  done(items, false, items.length ? '' : '未提取到条目(选择器需校准或结果未加载)');
}

/**
 * 在本面板 webview 里读一条笔记的评论树，回写 read-comments job。
 * 导航到笔记页 → 等就绪 → 判登录墙 → 滚动加载评论 → 跑评论提取器 → postCommentReadResult。
 */
async function runReadComments(
  el: DraftWebview | null,
  spec: CommentReadPaneSpec,
  isCancelled: () => boolean,
): Promise<void> {
  const { jobId, platform, noteRef } = spec;
  const say = (t: string) => { if (!isCancelled()) reportCommentReadProgress(jobId, t); };
  const finish = (comments: CommentNode[], needsLogin: boolean) => {
    if (isCancelled()) return;
    postCommentReadResult(jobId, comments, needsLogin);
  };
  if (!el) return finish([], false);
  const evalJs = async (js: string, timeoutMs = 4000): Promise<unknown> => {
    try {
      return await Promise.race([
        el.executeJavaScript(js),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
    } catch { return undefined; }
  };
  const url = buildNoteUrl(platform as CommentPlatform, noteRef);
  say(`打开笔记页…`);
  await evalJs(`location.href = ${JSON.stringify(url)}`, 4000);
  // 等就绪。
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (isCancelled()) return;
    const state = await evalJs('document.readyState', 2000);
    if (state === 'complete' || state === 'interactive') break;
    await new Promise((r) => setTimeout(r, 800));
  }
  await new Promise((r) => setTimeout(r, 1800));
  if (isCancelled()) return;
  // 登录墙判定。
  const walls = COMMENT_LOGIN_WALL[platform as CommentPlatform] ?? [];
  const bodyText = String((await evalJs('document.body ? document.body.innerText.slice(0, 3000) : ""', 3000)) || '');
  if (walls.some((w) => bodyText.includes(w)) && bodyText.length < 200) {
    say('未登录：请在标签里扫码登录后重试');
    return finish([], true);
  }
  // 滚动到评论区并多滚几次加载楼中楼（小红书评论懒加载）。
  for (let i = 0; i < 6; i++) {
    if (isCancelled()) return;
    await evalJs('window.scrollTo(0, document.body.scrollHeight)', 2000);
    await new Promise((r) => setTimeout(r, 900));
  }
  say('读取评论树…');
  const raw = await evalJs(COMMENT_EXTRACTORS[platform as CommentPlatform], 6000);
  const comments = Array.isArray(raw) ? (raw as CommentNode[]) : [];
  const total = comments.reduce((n, c2) => n + 1 + (c2.subReplies?.length ?? 0), 0);
  say(`读到 ${comments.length} 条一级评论 / 共 ${total} 条(含楼中楼)`);
  finish(comments, false);
}

/**
 * 在本面板 webview 里执行一次互动(自动评论回复/楼中楼),回写 interaction job 终态。
 * 名额已在 daemon 建 job 时(W1 风控台账)占用;这里只负责真实外发。
 */
async function runInteraction(
  el: DraftWebview | null,
  spec: InteractPaneSpec,
  isCancelled: () => boolean,
): Promise<void> {
  const { jobId } = spec;
  const say = (t: string) => { if (!isCancelled()) reportInteractionProgress(jobId, t); };
  const r = await runReplyInjection(el, spec, say);
  if (isCancelled()) return;
  completeInteractionJob(jobId, r.ok, r.detail);
}

/**
 * 在本面板 webview 里探测某 平台×账号 是否还登录着(W6),回写 login-check job。
 * 导航到平台主站 → 等就绪 → 跑登录探测脚本 → postLoginCheckResult(loggedIn) + completeLoginCheckJob。
 * 掉线时标签停在主站/登录页,顺便当扫码补登入口(用户扫完下次心跳/手动检测即翻回已登录)。
 */
// 注意:探测是【只读、幂等、约 8s】的操作,故 runLoginCheck【不吃 isCancelled】——一旦启动就
// 跑到底并回写终态。原因:pane 副作用的 cleanup(React 重渲染/StrictMode/同 pane 换 seq)会把
// cancelled 置真;若在这里早退,job 会永远停在 running(不像读评论有 listener 侧兜底 complete)。
// 重复触发顶多多探一次(幂等),远好过卡死。故这里不接 isCancelled 参数。
async function runLoginCheck(el: DraftWebview | null, spec: LoginCheckPaneSpec): Promise<void> {
  const { jobId, platform } = spec;
  const say = (t: string) => reportLoginCheckProgress(jobId, t);
  const finish = (loggedIn: boolean, detail: string) => {
    postLoginCheckResult(jobId, loggedIn, detail);
    completeLoginCheckJob(jobId, true, detail);
  };
  const probe = LOGIN_PROBE[platform];
  const home = LOGIN_HOME[platform];
  if (!el || !probe || !home) return finish(false, '该平台暂不支持登录态探测');
  const evalJs = async (js: string, timeoutMs = 4000): Promise<unknown> => {
    try {
      return await Promise.race([
        el.executeJavaScript(js),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
    } catch { return undefined; }
  };
  say('打开平台主站…');
  await evalJs(`location.href = ${JSON.stringify(home)}`, 4000);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await evalJs('document.readyState', 2000);
    if (state === 'complete' || state === 'interactive') break;
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 1500)); // 顶栏(头像/登录按钮)常在首帧后才渲染
  // 探测重试:登录标记可能懒渲染,unknown 就多等两轮再判(避免刚打开就误判掉线)。
  let result = parseLoginProbe(await evalJs(probe, 4000));
  for (let i = 0; i < 3 && result === 'unknown'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    result = parseLoginProbe(await evalJs(probe, 4000));
  }
  if (result === 'unknown') { say('登录态无法确定(页面未出现登录/头像标记),本次不改判'); return finish(false, 'unknown'); }
  const loggedIn = result === 'logged-in';
  say(loggedIn ? '仍在登录中 ✓' : '登录已失效——请在本标签扫码补登');
  finish(loggedIn, loggedIn ? '仍登录' : '登录失效,标签已停在登录页可扫码补登');
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
  /** 读评论载荷:导航到笔记页后抓评论树,seq 递增触发。 */
  readComments?: CommentReadPaneSpec;
  readCommentsSeq?: number;
  /** 互动执行载荷:打开目标页后做自动评论回复/楼中楼,seq 递增触发。 */
  interact?: InteractPaneSpec;
  interactSeq?: number;
  /** 登录态探测载荷:打开平台主站后判登录态,seq 递增触发。 */
  loginCheck?: LoginCheckPaneSpec;
  loginCheckSeq?: number;
  /** 「边播边抓」下载:导航到视频页、抓 <video> 直链后回报,seq 递增触发。 */
  grab?: { grabId: string };
  grabSeq?: number;
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
          // 已有面板:带 draft/collect/grab 再次打开=对同一面板重跑(seq 递增触发)。
          if (req.grab) {
            return list.map((p) =>
              p.key === key
                ? { ...p, url: req.url, grab: req.grab!, grabSeq: (p.grabSeq ?? 0) + 1 }
                : p,
            );
          }
          if (req.collect) {
            return list.map((p) =>
              p.key === key
                ? { ...p, url: req.url, collect: req.collect!, collectSeq: (p.collectSeq ?? 0) + 1 }
                : p,
            );
          }
          if (req.readComments) {
            return list.map((p) =>
              p.key === key
                ? { ...p, url: req.url, readComments: req.readComments!, readCommentsSeq: (p.readCommentsSeq ?? 0) + 1 }
                : p,
            );
          }
          if (req.interact) {
            return list.map((p) =>
              p.key === key
                ? { ...p, url: req.url, interact: req.interact!, interactSeq: (p.interactSeq ?? 0) + 1 }
                : p,
            );
          }
          if (req.loginCheck) {
            return list.map((p) =>
              p.key === key
                ? { ...p, loginCheck: req.loginCheck!, loginCheckSeq: (p.loginCheckSeq ?? 0) + 1 }
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
            ...(req.readComments ? { readComments: req.readComments, readCommentsSeq: 1 } : {}),
            ...(req.interact ? { interact: req.interact, interactSeq: 1 } : {}),
            ...(req.loginCheck ? { loginCheck: req.loginCheck, loginCheckSeq: 1 } : {}),
            ...(req.grab ? { grab: req.grab, grabSeq: 1 } : {}),
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
      {/* 采集状态条用到的动画:info 的转圈 + action(验证码/需登录)的脉冲高亮。 */}
      <style>{'@keyframes od-spin{to{transform:rotate(360deg)}}@keyframes od-pulse{0%,100%{opacity:1}50%{opacity:0.55}}'}</style>
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

  // 采集期在标签上显示的醒目状态(验证码/需登录时用户正看着这个标签)。
  const [collectStatus, setCollectStatus] = useState<CollectPaneStatus>(null);
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
      // 串行排队:一次只跑一个平台,避免并发抢资源导致慢平台采到 0。
      // 轮到本平台真正开始采集时,把视图切到它的浏览器标签,让用户【看得见】内置浏览器在
      // 逐个平台搜索+滚动(而不是后台悄悄跑、用户感知不到)。
      void enqueueCollect(async () => {
        if (cancelled) return;
        navigate({ kind: 'browser', platform: spec.platform, account: spec.account });
        setCollectStatus({ text: `正在采集「${spec.platform}」…`, kind: 'info' });
        await runCollect(
          ref.current as unknown as DraftWebview | null,
          collect,
          () => cancelled,
          (s) => { if (!cancelled) setCollectStatus(s); },
        );
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // 只依赖稳定的 collectSeq(数字)。若依赖 spec.collect(对象),父组件每次进度重渲染换了
    // 引用就会重跑本副作用 → cleanup 置 cancelled=true 把【正在采集的慢平台】(抖音/小红书)
    // 中途取消,快平台已采完躲过,于是并发下慢平台稳定 0 条。用 seq 后重渲染不再误杀采集。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.collectSeq]);

  // 读评论:面板加载后在【本标签 webview】里导航到笔记页、抓评论树,回写 read-comments job。
  const ranReadRef = useRef(0);
  useEffect(() => {
    const seq = spec.readCommentsSeq ?? 0;
    if (!spec.readComments || seq === 0 || seq === ranReadRef.current) return;
    const readSpec = spec.readComments;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      ranReadRef.current = seq;
      navigate({ kind: 'browser', platform: spec.platform, account: spec.account });
      void runReadComments(ref.current as unknown as DraftWebview | null, readSpec, () => cancelled);
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.readCommentsSeq]);

  // 互动执行:面板加载后在【本标签 webview】里做自动评论回复/楼中楼,回写 interaction job 终态。
  const ranInteractRef = useRef(0);
  useEffect(() => {
    const seq = spec.interactSeq ?? 0;
    if (!spec.interact || seq === 0 || seq === ranInteractRef.current) return;
    const interactSpec = spec.interact;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      ranInteractRef.current = seq;
      // 互动要用户看得见拟人操作(评论区高频发言,让用户能随时叫停),切到本标签前台。
      navigate({ kind: 'browser', platform: spec.platform, account: spec.account });
      void runInteraction(ref.current as unknown as DraftWebview | null, interactSpec, () => cancelled);
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.interactSeq]);

  // 登录态探测:在【本标签 webview】里打开平台主站判登录态,回写 login-check job。
  // 【不】切前台——心跳每 15 分钟跑一次,不能反复抢用户视图;掉线后账号页给「去补登」按钮再切前台。
  const ranLoginRef = useRef(0);
  useEffect(() => {
    const seq = spec.loginCheckSeq ?? 0;
    if (!spec.loginCheck || seq === 0 || seq === ranLoginRef.current) return;
    const loginSpec = spec.loginCheck;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      ranLoginRef.current = seq;
      // 探测只读幂等,启动后跑到底(不传 isCancelled)——避免重渲染 cleanup 把它掐死导致 job 卡 running。
      void runLoginCheck(ref.current as unknown as DraftWebview | null, loginSpec);
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.loginCheckSeq]);

  // 「边播边抓」下载:导航到视频页 → 播放触发加载 → 抓 <video> 直链(或页面里的 mp4)→ 回报。
  const ranGrabRef = useRef(0);
  useEffect(() => {
    const seq = spec.grabSeq ?? 0;
    if (!spec.grab || seq === 0 || seq === ranGrabRef.current) return;
    ranGrabRef.current = seq;
    const grabId = spec.grab.grabId;
    let cancelled = false;
    const el = () => ref.current as unknown as DraftWebview | null;
    const evalOn = async (js: string, ms = 6000): Promise<unknown> => {
      const w = el();
      if (!w) return undefined;
      try {
        return await Promise.race([
          w.executeJavaScript(js),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
        ]);
      } catch { return undefined; }
    };
    const report = (result: { mediaUrl: string; referer: string } | { error: string }) => {
      window.dispatchEvent(new CustomEvent(GRAB_VIDEO_RESULT_EVENT, { detail: { grabId, result } }));
    };
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      navigate({ kind: 'browser', platform: spec.platform, account: spec.account });
      await evalOn(`location.href=${JSON.stringify(spec.url)}`, 4000);
      // 抓取脚本:等 <video> 出现并有 http 直链;拿不到就扫页面里的 .mp4 直链兜底。
      const grabJs = `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        for(let i=0;i<25&&!${'false'};i++){const v=document.querySelector('video');
          if(v){try{v.muted=true;v.play();}catch(e){}
            const s=v.currentSrc||v.src||'';
            if(/^https?:/.test(s))return JSON.stringify({mediaUrl:s,referer:location.href});}
          await sleep(1000);}
        const h=document.documentElement.innerHTML;
        const m=h.match(/https?:\\/\\/[^"'\\\\\\s]+\\.mp4[^"'\\\\\\s]*/);
        if(m)return JSON.stringify({mediaUrl:m[0].replace(/\\\\u002F/g,'/'),referer:location.href});
        return JSON.stringify({error:'no-src'});})()`;
      const raw = (await evalOn(grabJs, 40_000)) as string | undefined;
      if (cancelled) return;
      try {
        const parsed = JSON.parse(String(raw || '{}'));
        if (parsed.mediaUrl) report({ mediaUrl: parsed.mediaUrl, referer: parsed.referer || spec.url });
        else report({ error: '没在页面抓到视频直链(可能是加密流)——可在浏览器里右键手动保存' });
      } catch {
        report({ error: '抓取解析失败——可在浏览器里右键手动保存视频' });
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.grabSeq]);

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
      {/* 采集状态醒目条:验证码/需登录(kind=action)时红底加粗常驻,提示用户在下方浏览器里
          完成操作,完成后自动继续采集(2026-07-14 用户要求"撞验证码要停下等 + 有提示")。 */}
      {collectStatus ? (
        <div
          role={collectStatus.kind === 'action' ? 'alert' : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            fontSize: 13.5, fontWeight: 700, lineHeight: 1.5,
            background: collectStatus.kind === 'action' ? 'rgba(220,38,38,0.14)' : 'rgba(232,88,46,0.08)',
            color: collectStatus.kind === 'action' ? '#dc2626' : '#e8582e',
            borderBottom: `1px solid ${collectStatus.kind === 'action' ? 'rgba(220,38,38,0.5)' : 'rgba(232,88,46,0.3)'}`,
            ...(collectStatus.kind === 'action' ? { animation: 'od-pulse 1.2s ease-in-out infinite' } : {}),
          }}
        >
          {collectStatus.kind === 'info' ? (
            <span style={{
              width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(232,88,46,0.35)',
              borderTopColor: '#e8582e', display: 'inline-block', animation: 'od-spin 0.8s linear infinite', flex: '0 0 auto',
            }} />
          ) : null}
          <span>{collectStatus.text}</span>
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
