// 「一键存草稿」注入引擎(2026-07-09 用户拍板:自动把稿件填进平台发布页,
// 免手动上传)。在应用内后台面板的 <webview> 里分步执行:登录墙检测 →
// CDP 塞文件 → 等编辑表单出现 → 填标题/正文 → 只点「存草稿」类按钮。
//
// 铁律:
//  1. 绝不点「发布」——按钮匹配只认「存草稿/暂存/保存离开」白名单文案,
//     对外发布永远留给人。
//  2. 每一步失败都不阻断:返回可读的进度报告,文案已提前在剪贴板,用户
//     随时可以接手手动粘贴。
//  3. 选择器按当前平台页面结构编写(2026-07),平台改版后可能需要跟修——
//     这是所有"填稿工具"的共同宿命,失败路径已兜底。
import { setHostBrowserFileInput } from '@open-design/host';
import { markdownToZhihuHtml } from '../components/media-studio/zhihu-preview';
import { submitBilibiliDraft } from '../providers/media-studio';
import { exportBrowserCookies } from './browser-panes';

export interface DraftPayload {
  /** 目标平台 id(xiaohongshu/douyin/...)。 */
  platform: string;
  title: string;
  body: string;
  /** 不带 # 的标签词。 */
  tags: string[];
  /** 本机文件绝对路径(图集按序/成片)。 */
  filePaths: string[];
  kind: 'images' | 'video' | 'article';
  /** article 专用:正文按图片位置切分的段序列——文本段真实键入,图片段
   *  在原位 CDP 插入(知乎正文图 input 常驻,插到光标处)。 */
  segments?: Array<{ type: 'text'; text: string } | { type: 'image'; path: string }>;
  /** article 专用:封面图本机绝对路径(知乎「添加文章封面」区)。 */
  coverPath?: string;
  /** 目标页 URL(百度知道=要回答的问题页):注入前先导航到它,而不是停在平台默认发布页。 */
  targetUrl?: string;
  /** 一键发布(2026-07-10 用户拍板+二次确认授权):填稿后真实点击平台的
   *  「发布/发送」按钮直发。缺省 false=只填到发送前一步(草稿/发布框)。 */
  autoPublish?: boolean;
}

export interface DraftResult {
  ok: boolean;
  /** 用户可读的结果(成功=已存草稿/已填好待存;失败=卡在哪一步+怎么接手)。 */
  detail: string;
}

export type DraftProgress = (message: string) => void;

/** Electron <webview> 的注入 API 子集。 */
export interface DraftWebview extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  getWebContentsId(): number;
  getURL(): string;
  /** 真实输入事件(鼠标坐标系=webview 视口;键盘 char/keyDown/keyUp)——
   *  走系统级输入管线,isTrusted=true,能穿透 closed shadow DOM。 */
  sendInputEvent(event: {
    type: string;
    x?: number;
    y?: number;
    button?: string;
    clickCount?: number;
    keyCode?: string;
    modifiers?: string[];
  }): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function wvEval<T>(wv: DraftWebview, code: string): Promise<T | null> {
  try {
    // webview 在页面加载/导航中 executeJavaScript 可能挂起不返回(不 reject),
    // 必须超时竞速,否则整条注入流水线卡死。
    return (await Promise.race([
      wv.executeJavaScript(code),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wv-eval-timeout')), 8000)),
    ])) as T;
  } catch {
    return null;
  }
}

/** 页面里按可见文本找元素并点击(只点白名单文案,调用方保证语义安全)。 */
async function clickByText(wv: DraftWebview, texts: string[]): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const wants = ${JSON.stringify(texts)};
      const nodes = [...document.querySelectorAll('button, [role="button"], div, span, a')];
      for (const want of wants) {
        const el = nodes.find((n) => (n.textContent || '').trim() === want && n.getClientRects().length > 0);
        if (el) { el.click(); return true; }
      }
      return false;
    })()`,
  );
  return ok === true;
}

/** 轮询直到页面上出现匹配选择器的可见元素。 */
export async function waitFor(wv: DraftWebview, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await wvEval<boolean>(
      wv,
      `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.getClientRects().length > 0))`,
    );
    if (found) return true;
    await sleep(1000);
  }
  return false;
}

/** 未登录检测:发布页会被重定向/盖登录墙。 */
async function isLoginWall(wv: DraftWebview): Promise<boolean> {
  const flag = await wvEval<boolean>(
    wv,
    `(() => {
      const t = document.body?.innerText || '';
      const hasLoginUi = /扫码登录|手机号登录|登录后继续|立即登录/.test(t);
      const url = location.href;
      return hasLoginUi || /login|passport/i.test(url);
    })()`,
  );
  return flag === true;
}

/** React 受控 input 赋值(native setter + input 事件)。 */
async function fillInput(wv: DraftWebview, selector: string, value: string): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!set) return false;
      el.focus();
      set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  return ok === true;
}

/** 富文本编辑器(contenteditable)插入纯文本。插完 blur 收焦点——正文里的
 *  #标签 会触发话题联想弹层,不收掉会挡住底部「存草稿」按钮。 */
async function fillEditor(wv: DraftWebview, text: string): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const ed = [...document.querySelectorAll('[contenteditable="true"]')].find((n) => n.getClientRects().length > 0);
      if (!ed) return false;
      ed.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      ed.blur();
      document.body.click();
      return true;
    })()`,
  );
  return ok === true;
}

// ---- 系统级真实键入(2026-07-09 用户拍板:文本也走真实输入管线,连打字
// 节奏都是真的)。sendInputEvent 产生的鼠标/键盘事件与真人操作同级
// (isTrusted=true),页面无法区分;合成填充(fillInput/fillEditor)降为兜底。 ----

function humanDelay(ch: string): number {
  // 快速打字者的节奏:字均 25-85ms 抖动;标点/换行后 120-280ms 停顿(换气)。
  if (/[。！？!?\n]/.test(ch)) return 120 + Math.random() * 160;
  if (/[，、；;,.\s]/.test(ch)) return 60 + Math.random() * 90;
  return 25 + Math.random() * 60;
}

/** 找到可见元素并滚到视野中央,返回视口矩形。scrollIntoView 后布局可能
 *  未稳(负坐标),先滚再等一拍读 rect。 */
async function rectOf(wv: DraftWebview, selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  await wvEval(
    wv,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0); if (el) el.scrollIntoView({ block: 'center' }); })()`,
  );
  await sleep(350);
  return wvEval<{ x: number; y: number; w: number; h: number } | null>(
    wv,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`,
  );
}

function clickAt(wv: DraftWebview, x: number, y: number): void {
  wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/** 真人式移动光标到 (x,y):从一个偏移起点分几步(smoothstep 缓动 + 轻微抖动)移过去。
 *  真人点击前一定有移动轨迹,直接在目标点 mouseDown 是明显的脚本信号(抖音搜索必弹验证码
 *  的主因之一)。 */
async function moveMouseHuman(wv: DraftWebview, x: number, y: number): Promise<void> {
  const steps = 8 + Math.floor(Math.random() * 6);
  const sx = x - (90 + Math.random() * 160) * (Math.random() < 0.5 ? 1 : -1);
  const sy = y - (60 + Math.random() * 120);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep
    const jx = (Math.random() - 0.5) * 6;
    const jy = (Math.random() - 0.5) * 6;
    wv.sendInputEvent({ type: 'mouseMove', x: Math.round(sx + (x - sx) * ease + jx), y: Math.round(sy + (y - sy) * ease + jy) });
    await sleep(10 + Math.random() * 22);
  }
  wv.sendInputEvent({ type: 'mouseMove', x, y });
}

/** 真人式点击:先移动光标过去,停一下,再按下→短停→抬起(按压时长像真人)。 */
async function humanClickAt(wv: DraftWebview, x: number, y: number): Promise<void> {
  await moveMouseHuman(wv, x, y);
  await sleep(60 + Math.random() * 120);
  wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(45 + Math.random() * 70);
  wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/** JS 合成聚焦(坐标点击落空时的兜底):focus + 光标置末尾。 */
async function focusBySelector(wv: DraftWebview, selector: string): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      el.focus();
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* input/textarea 无 selection API,focus 足够 */ }
      return document.activeElement === el || el.contains(document.activeElement);
    })()`,
  );
  return ok === true;
}

/** 真实鼠标点击目标元素完成聚焦;元素在视口外(负坐标)或点击没落上时,
 *  退回 JS 合成聚焦(2026-07-10 知乎正文 y=-304 视口外导致键入落空)。 */
export async function focusByClick(wv: DraftWebview, selector: string): Promise<boolean> {
  const r = await rectOf(wv, selector);
  if (!r || r.w < 4) return focusBySelector(wv, selector);
  // 元素在视口外(负坐标/超出下方):坐标点击无效,直接合成聚焦。
  if (r.y < 8 || r.y > 2000) return focusBySelector(wv, selector);
  // 点前部而非正中心:输入框中央可能盖着 placeholder 联想图标。真人式移动+点击(带轨迹)。
  await humanClickAt(wv, Math.round(r.x + Math.min(r.w / 2, 60)), Math.round(r.y + r.h / 2));
  await sleep(280 + Math.random() * 160);
  // 校验真的聚焦上了,没有就合成兜底。
  const focused = await wvEval<boolean>(
    wv,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0); return Boolean(el) && (document.activeElement === el || el.contains(document.activeElement)); })()`,
  );
  if (!focused) return focusBySelector(wv, selector);
  return true;
}

/** 全选+删除清空当前聚焦字段——同样走真实键盘(⌘/Ctrl+A → Backspace)。 */
async function clearFieldByKeys(wv: DraftWebview): Promise<void> {
  const mod = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? 'cmd' : 'control';
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [mod] });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [mod] });
  await sleep(90);
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await sleep(140);
}

/** 确定性清空字段(2026-07-10 微博直发实测:重复 handoff 时旧残留没被
 *  Cmd+A 清掉,直发出去内容拼了两遍)。合成键盘快捷键在部分站点静默失效,
 *  这里直接走 DOM:input/textarea 用原生 value setter(触发 React/Vue 的
 *  input 事件),contenteditable 全选后 execCommand 删除。键盘清空保留为
 *  第二道保险。 */
async function clearFieldBySelector(wv: DraftWebview, selector: string): Promise<void> {
  await wvEval(
    wv,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        if (!el.value) return true;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        if (!(el.textContent || '').trim()) return true;
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        return true;
      }
      return false;
    })()`,
  );
  await sleep(120);
}

/** 逐字真实键入(char 事件);onProgress 按 10% 步长回报。
 *  必须按「字素」迭代而非 UTF-16 码元:emoji(📌⚠️)是代理对/组合序列,
 *  按码元拆开发 char 会撕成两个孤立代理,页面渲染成 ��(2026-07-09 用户
 *  报草稿乱码)。emoji 字素走 insertText 整体插入——真人输入 emoji 也是
 *  从表情面板「选」而不是「打」,行为模式反而更真实。 */
export async function typeText(
  wv: DraftWebview,
  text: string,
  onProgress?: (percent: number) => void,
  opts?: { slow?: boolean },
): Promise<void> {
  const graphemes =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
      : [...text]; // 兜底:按码点迭代(仍优于码元)
  let lastReported = -1;
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]!;
    if (g === '\n') {
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      wv.sendInputEvent({ type: 'char', keyCode: '\r' });
      wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    } else if (g.length === 1 && !/\p{Extended_Pictographic}/u.test(g)) {
      // 单码元普通字符(汉字/字母/标点)→ 真实键盘 char 事件。
      wv.sendInputEvent({ type: 'char', keyCode: g });
    } else {
      // emoji/组合字素 → 整体插入到当前焦点(等价表情面板选入)。
      await wvEval(wv, `document.execCommand('insertText', false, ${JSON.stringify(g)})`);
    }
    // slow 模式(采集搜索用,躲反爬):字均放慢约 1.8 倍,且约 18% 概率来一次
    // 200-650ms 的"想一下/看一眼"停顿——真人搜关键词不是匀速一口气敲完的。
    let delay = humanDelay(g);
    if (opts?.slow) {
      delay = Math.round(delay * 1.8);
      if (Math.random() < 0.18) delay += 200 + Math.random() * 450;
    }
    await sleep(delay);
    const pct = Math.floor(((i + 1) / graphemes.length) * 10) * 10;
    if (onProgress && pct !== lastReported && pct > 0) {
      lastReported = pct;
      onProgress(pct);
    }
  }
}

/** 真实回车(keyDown + char\r + keyUp)。 */
export function pressEnter(wv: DraftWebview): void {
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wv.sendInputEvent({ type: 'char', keyCode: '\r' });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}

// ---- 真人模拟搜索(爆款采集用)。2026-07-14 用户报"总触发抖音验证码":
// 采集原来的 buildSearchSubmitJs 走 JS 合成事件(dispatchEvent 的 KeyboardEvent/
// InputEvent 是 isTrusted=false),抖音/小红书反爬一眼识破 → 弹验证码。这里改走
// 和发布同一套【系统级真实输入管线】:真鼠标点搜索框聚焦 → 逐字符真实 char 键入
// (带真人打字节奏抖动)→ 真实回车。isTrusted=true,页面无法与真人区分。 ----

const SEARCH_INPUT_SEL =
  'input[data-e2e*="search"], input[placeholder*="搜索"], input[placeholder*="搜"], .search-input input, input.search-input, input[type="search"], header input';
const SEARCH_ENTRY_SEL =
  '[data-e2e*="search"], [class*="search-entry"], [class*="searchEntry"], [class*="search-icon"], [aria-label*="搜索"]';

/**
 * 像真人一样在当前页面的搜索框里搜关键词:必要时先真点开搜索入口 → 真鼠标点框聚焦 →
 * 逐字符真实键入 → 真实回车。全程 sendInputEvent(isTrusted=true),不触发反爬验证码。
 * 返回 'submitted'（已提交）/ 'no-input'（页面上找不到搜索框,交由调用方兜底直连搜索 URL）。
 */
export async function humanSearch(wv: DraftWebview, keyword: string): Promise<'submitted' | 'no-input'> {
  // 0) 【落地先停一下、看两眼、随手滑一下 feed】真人到站不会秒搜——多晃几下鼠标 + 轻轻滚一下
  //    首页再回顶部,给反爬足够的"人在看"信号,再开始搜。抖音搜索反爬对"一进来就搜"最敏感。
  await moveMouseHuman(wv, 260 + Math.random() * 380, 180 + Math.random() * 220);
  await sleep(900 + Math.random() * 1300);
  await moveMouseHuman(wv, 200 + Math.random() * 520, 320 + Math.random() * 260);
  await wvEval(wv, `window.scrollBy(0, ${200 + Math.floor(Math.random() * 320)})`);
  await sleep(800 + Math.random() * 1100);
  await moveMouseHuman(wv, 240 + Math.random() * 420, 200 + Math.random() * 200);
  await wvEval(wv, 'window.scrollTo({ top: 0 })');
  await sleep(600 + Math.random() * 700);
  // 1) 搜索框不在 → 真人式点开搜索入口(有些站首页要先点放大镜才出输入框)。
  let rect = await rectOf(wv, SEARCH_INPUT_SEL);
  if (!rect || rect.w < 4) {
    const entry = await rectOf(wv, SEARCH_ENTRY_SEL);
    if (entry && entry.w >= 4 && entry.y > 8 && entry.y < 2000) {
      await humanClickAt(wv, Math.round(entry.x + entry.w / 2), Math.round(entry.y + entry.h / 2));
      await sleep(800 + Math.random() * 700);
    }
    rect = await rectOf(wv, SEARCH_INPUT_SEL);
  }
  if (!rect || rect.w < 4) return 'no-input';
  // 2) 真鼠标(带移动轨迹)点击搜索框聚焦(坐标落空自动退回 JS 合成聚焦)。
  const focused = await focusByClick(wv, SEARCH_INPUT_SEL);
  if (!focused) return 'no-input';
  await sleep(500 + Math.random() * 600); // 点完盯一眼输入框再动手,像真人
  // 3) 清掉可能的残留 → 逐字【慢速】真实键入(带想一下的停顿）→ 打完再确认一下才回车。
  await clearFieldByKeys(wv);
  await typeText(wv, keyword, undefined, { slow: true });
  await sleep(900 + Math.random() * 1200);
  // 4) 真实回车提交。
  pressEnter(wv);
  return 'submitted';
}

/** 键入一个话题标签并从联想弹层确认成「真话题实体」(2026-07-09 用户报
 *  标签停留为纯文本)。小红书实测:键入 #词 → tippy 弹层首项默认选中
 *  (div.tippy-content .item.is-selected) → 回车 → 生成 a.tiptap-topic
 *  实体(带话题 id/链接+尾随空格)。抖音/快手用同一套路,弹层选择器给
 *  多个候选;弹层没出现就补空格结束纯文本(不劣化现状)。 */
async function typeHashtag(wv: DraftWebview, tag: string): Promise<'entity' | 'text'> {
  await typeText(wv, `#${tag}`);
  const POPUP_SEL = '.tippy-content .item, [class*="mention"] [class*="item"], [class*="suggestion-list"] li, [class*="topic-list"] li';
  const deadline = Date.now() + 2500;
  let popupReady = false;
  while (Date.now() < deadline) {
    const found = await wvEval<boolean>(
      wv,
      `Boolean([...document.querySelectorAll(${JSON.stringify(POPUP_SEL)})].find((el) => el.getClientRects().length > 0))`,
    );
    if (found) {
      popupReady = true;
      break;
    }
    await sleep(300);
  }
  if (popupReady) {
    await sleep(200 + Math.random() * 200);
    pressEnter(wv);
    await sleep(450 + Math.random() * 200);
    return 'entity';
  }
  wv.sendInputEvent({ type: 'char', keyCode: ' ' });
  await sleep(120);
  return 'text';
}

/** 逐个键入话题标签(需焦点已在目标编辑器内、光标在末尾)。 */
async function typeHashtags(wv: DraftWebview, tags: string[], progress?: (i: number, total: number) => void): Promise<void> {
  for (let i = 0; i < tags.length; i++) {
    progress?.(i + 1, tags.length);
    await typeHashtag(wv, tags[i]!);
  }
}

/** 真实键入一个字段:点击聚焦 → 键盘清场 → 逐字输入。 */
async function typeIntoField(
  wv: DraftWebview,
  selector: string,
  text: string,
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (!(await focusByClick(wv, selector))) return false;
  // 双保险清空:DOM 确定性清空(主) + 键盘全选删除(兜底)——残留内容直发
  // 出去比失败更糟。
  await clearFieldBySelector(wv, selector);
  await clearFieldByKeys(wv);
  await typeText(wv, text, onProgress);
  await sleep(200);
  return true;
}

async function setFiles(
  wv: DraftWebview,
  files: string[],
  selector = 'input[type=file]',
): Promise<{ ok: boolean; reason?: string }> {
  const result = await setHostBrowserFileInput({
    webContentsId: wv.getWebContentsId(),
    selector,
    files,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** 把富文本 HTML「粘贴」进 contenteditable(2026-07-10 用户报知乎 markdown
 *  显示字面符号+逐字键入长文抢焦点)。给编辑器一个带 text/html 的 paste
 *  事件——知乎 DraftJS 解析成真富文本(实测 h2/加粗/列表全对),且一次完成
 *  不再逐字键入几分钟,主窗口不被长时间占用。DraftJS 从当前光标处插入,
 *  所以文本段与图片段可交替(图片段仍走 CDP 上传本地文件)。 */
async function pasteHtmlAtCursor(wv: DraftWebview, html: string, plain: string): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const ed = [...document.querySelectorAll('[contenteditable="true"]')].find((n) => n.getClientRects().length > 0);
      if (!ed) return false;
      ed.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', ${JSON.stringify(html)});
      dt.setData('text/plain', ${JSON.stringify(plain)});
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return true;
    })()`,
  );
  return ok === true;
}

/** 编辑器内可见图片数(等待插图完成用)。 */
async function editorImageCount(wv: DraftWebview): Promise<number> {
  const n = await wvEval<number>(
    wv,
    `(() => { const ed = [...document.querySelectorAll('[contenteditable="true"]')].find((el) => el.getClientRects().length); return ed ? ed.querySelectorAll('img').length : 0; })()`,
  );
  return typeof n === 'number' ? n : 0;
}

/** 小红书的底部按钮是 <xhs-publish-btn> 自定义组件(closed shadow DOM,
 *  文本匹配永远找不到):save-text=「暂存离开」在左、submit-text=「发布」
 *  在右。用真实鼠标事件按坐标点左键位(组件宽度 40% 处,截图实测暂存键
 *  覆盖 30%-48% 区间);守卫:计算点绝不越过组件中线——右半是「发布」。 */
async function clickXhsSaveDraftByCoords(wv: DraftWebview): Promise<boolean> {
  const rect = await wvEval<{ x: number; y: number; w: number; h: number } | null>(
    wv,
    `(() => {
      const el = document.querySelector('xhs-publish-btn');
      if (!el || el.getAttribute('is-save-draft') !== 'true') return null;
      if (el.getAttribute('save-disabled') === 'true') return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`,
  );
  if (!rect || rect.w < 100) return false;
  const x = Math.round(rect.x + rect.w * 0.4);
  const y = Math.round(rect.y + rect.h / 2);
  if (x >= rect.x + rect.w * 0.5) return false; // 绝不越中线(右半=发布)
  wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return true;
}

/** 按精确文本找按钮并「真实鼠标坐标点击」(用于一键发布的发布/发送键——
 *  真实点击 isTrusted=true,与真人无异)。只点精确匹配的白名单文案。 */
export async function clickRealByText(wv: DraftWebview, texts: string[]): Promise<boolean> {
  const rect = await wvEval<{ x: number; y: number; w: number; h: number } | null>(
    wv,
    `(() => {
      const wants = ${JSON.stringify(texts)};
      const nodes = [...document.querySelectorAll('button, [role="button"], a, span, div')];
      for (const want of wants) {
        const el = nodes.find((n) => (n.textContent || '').trim() === want && n.getClientRects().length > 0 && !(n.disabled));
        if (el) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }
      }
      return null;
    })()`,
  );
  if (!rect || rect.w < 4) return false;
  clickAt(wv, Math.round(rect.x), Math.round(rect.y));
  return true;
}

/** 只点「存草稿」类按钮——白名单文案,绝不含「发布」。按钮可能在图片
 *  处理完/弹层收起后才可点,重试轮询最多 6 次;文本匹配不中时走小红书
 *  自定义组件的坐标点击路径。 */
async function clickSaveDraft(wv: DraftWebview): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const ok = await clickByText(wv, ['存草稿', '暂存离开', '保存草稿', '保存离开', '存为草稿']);
    if (ok) return true;
    if (await clickXhsSaveDraftByCoords(wv)) return true;
    await sleep(1200);
  }
  return false;
}

// 小红书视频封面(用户在发布页上传的封面图):点「编辑封面/设置封面」→ 弹层里切「上传封面」
// tab → CDP 塞图到图片文件输入 → 点「确定/完成」。小红书封面默认是抽帧,上传是次要 tab,
// 找不到上传入口就跳过(不阻断存草稿)。★真实页面文案/结构待登录后校准。
async function uploadXiaohongshuCover(wv: DraftWebview, coverPath: string, progress: DraftProgress): Promise<boolean> {
  // 打开封面编辑弹层(优先真实点击)。
  if (!(await clickRealByText(wv, ['编辑封面', '设置封面', '选择封面', '封面']))
    && !(await clickByText(wv, ['编辑封面', '设置封面', '选择封面', '封面']))) return false;
  await sleep(1500);
  // 弹层里切到「上传封面/上传图片/本地上传」tab(默认是抽帧)。
  await clickByText(wv, ['上传封面', '上传图片', '本地上传', '上传']);
  await sleep(800);
  const put = await setFiles(wv, [coverPath], 'input[type=file][accept*="image"]');
  if (!put.ok) return false;
  await sleep(2600); // 等封面上传 + 预览
  const done =
    (await clickRealByText(wv, ['确定', '完成', '确认', '保存', '下一步']))
    || (await clickByText(wv, ['确定', '完成', '确认', '保存', '下一步']));
  await sleep(1200);
  if (progress && !done) progress('封面已传但没自动点「确定」——可在页面手动确认');
  return true;
}

// ---- 小红书(图文 / 视频) ----
async function injectXiaohongshu(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '小红书还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  const isVideo = draft.kind === 'video';

  if (isVideo) {
    // 发布页默认就是「上传视频」tab(实测 active),且页面上「上传视频」还有个中心圆形
    // 上传按钮——点它会触发原生文件选择框(卡死注入)。所以视频路【不点 tab】,直接 CDP
    // 塞文件到隐藏的视频输入(setFiles 走 DOM.setFileInputFiles,对隐藏输入也生效)。
    progress('1/6 准备上传视频…');
    await sleep(600);
    progress('2/6 上传视频…');
    // 小红书视频输入的 accept 是扩展名列表 `.mp4,.mov,.flv,…`(实测,非 video/*),
    // 按 mp4 匹配才命中;失败退回通用 setFiles 自动找第一个文件输入(默认就是视频 tab)。
    const put = (await setFiles(wv, draft.filePaths, 'input[type=file][accept*="mp4"]')).ok
      ? { ok: true }
      : await setFiles(wv, draft.filePaths);
    if (!put.ok) {
      return { ok: false, detail: '视频注入失败——请手动拖入(视频文件夹已可从发布步打开)' };
    }
  } else {
    progress('1/6 切换到「上传图文」…');
    // 图文 tab 用【真实鼠标点击】切换(小红书 React tab,JS el.click() 常不生效);兜底再 JS 点。
    await clickRealByText(wv, ['上传图文']);
    await clickByText(wv, ['上传图文']);
    // 轮询等【图片输入】进 DOM(tab 切过去才渲染出来)。文件输入常隐藏,waitFor 的可见性判定
    // 抓不到,这里直接查 DOM 存在性。最多 8 秒。
    const IMG_INPUT = 'input[type=file][accept*="jpg"], input[type=file][accept*="png"], input[type=file][accept*="image"]';
    for (let i = 0; i < 8; i++) {
      if (await wvEval<boolean>(wv, `Boolean(document.querySelector(${JSON.stringify(IMG_INPUT)}))`)) break;
      await sleep(1000);
    }
    progress(`2/6 上传 ${draft.filePaths.length} 张图…`);
    // 关键:图文输入 accept=`.jpg,.jpeg,.png,.webp`,和【视频输入同 class .upload-input】——用默认
    // input[type=file] 会命中【视频】输入(它拒收 jpg)→ 图集传不上去、后面表单全不出(2026-07-16
    // 用户报"图集传不上、标题正文没填、按钮没点到"的根因)。这里按 accept 精确命中【图片】输入。
    let put = await setFiles(wv, draft.filePaths, IMG_INPUT);
    if (!put.ok) put = await setFiles(wv, draft.filePaths);   // 兜底:通用第一个文件输入
    if (!put.ok) {
      return { ok: false, detail: `图片注入失败(${put.reason ?? '未知'})——请确认已切到「上传图文」页,或手动拖入(图集文件夹已可从发布步打开)` };
    }
  }

  progress('3/6 等编辑表单就绪…');
  // 传完后小红书才渲染标题/正文表单;等标题框出现。视频要转码,等得久些。
  const formReady = await waitFor(wv, 'input[placeholder*="标题"], input[placeholder*="填写标题"]', isVideo ? 120_000 : 60_000);
  if (!formReady) {
    return { ok: false, detail: isVideo
      ? '视频已提交但编辑表单没等到(可能还在转码)——表单出现后手动粘贴文案即可,文案在剪贴板'
      : '图片已提交但编辑表单没等到(可能还在处理)——表单出现后手动粘贴文案即可,文案在剪贴板' };
  }

  progress('4/6 键入标题…');
  // 真实键入(系统级输入管线,带打字节奏);失败退回合成填充兜底。
  const TITLE_SEL = 'input[placeholder*="标题"], input[placeholder*="填写标题"]';
  const titleOk =
    (await typeIntoField(wv, TITLE_SEL, draft.title.slice(0, 20)))
    || (await fillInput(wv, TITLE_SEL, draft.title.slice(0, 20)));
  // 正文与标签分开:正文逐字键入;标签走「#词+联想弹层回车」确认成
  // 真话题实体(纯拼在正文里只是文本,不是话题)。
  const bodyOk =
    (await typeIntoField(wv, '[contenteditable="true"]', draft.body, (pct) => progress(`4/6 键入正文… ${pct}%`)))
    || (await fillEditor(wv, draft.body));
  if (!titleOk && !bodyOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴;把这个情况反馈给我们跟修' };
  }
  if (bodyOk && draft.tags.length > 0) {
    // 光标此刻在正文末尾;空一段再逐个上话题。
    await typeText(wv, '\n');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`4/6 话题 ${i}/${total}…`));
  }
  // 点页面空白处收残留联想弹层(真实点击),它会挡底部「存草稿」。
  clickAt(wv, 20, 200);
  await sleep(600);

  // 视频封面(用户在发布页上传的封面);图文没有封面概念,跳过。
  if (isVideo && draft.coverPath) {
    progress('5/6 封面 · 上传中…');
    await uploadXiaohongshuCover(wv, draft.coverPath, progress);
  }

  progress('6/6 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到小红书草稿箱——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已全部填好——没找到「存草稿」按钮(可能改版),请在面板里手动点一下暂存/发布' };
}

// ---- 抖音(视频) ----
// 抖音创作者中心的拦截弹窗:进上传页时若有上次未发布草稿会弹「你还有上次未发布的视频,是否
// 继续编辑?继续编辑/放弃」——不关掉会挡住新成片的上传;各种功能通知弹「我知道了」。注入前后
// 都清一遍,否则表单/存草稿按钮点不到(2026-07-14 用户报"存草稿没成功"的主因之一)。
async function dismissDouyinBlockers(wv: DraftWebview): Promise<void> {
  // 上次未发布草稿:点「放弃」(注入本就是传新成片)。可能弹二次确认,紧跟着补点确定/确认。
  if (await clickByText(wv, ['放弃'])) {
    await sleep(500);
    await clickByText(wv, ['确定', '确认', '放弃']); // 仅在点了放弃后才点确认,避免误点表单里的确定
    await sleep(400);
  }
  // 各种功能通知弹层:点「我知道了」。
  for (const t of ['我知道了', '知道了']) {
    if (await clickByText(wv, [t])) await sleep(400);
  }
}

// 自动上传封面(用户在发布页上传的封面图):点「设置封面」→ 打开封面弹层 → CDP 塞图到封面
// 专用文件输入(accept=image/*)→ 点「完成/确定」保存。实测:封面文件输入是隐藏的
// input[type=file][accept*=image];视频输入是 accept*=video——按 accept 区分,别塞错。
async function uploadDouyinCover(wv: DraftWebview, coverPath: string, progress: DraftProgress): Promise<boolean> {
  // 真实点击「设置封面」打开封面弹层(JS click 对抖音 React 常不生效),落空再退回 JS 点击。
  if (!(await clickRealByText(wv, ['设置封面'])) && !(await clickByText(wv, ['设置封面']))) return false;
  await sleep(1600);
  const put = await setFiles(wv, [coverPath], 'input[type=file][accept*="image"]');
  if (!put.ok) return false;
  await sleep(3200); // 等封面上传 + 预览渲染
  // 弹层里保存封面:优先真实点击「完成/确定」(抖音 React 按钮 JS click 常不生效)。
  const done =
    (await clickRealByText(wv, ['完成', '确定', '确认', '保存', '下一步']))
    || (await clickByText(wv, ['完成', '确定', '确认', '保存', '下一步']));
  await sleep(1500);
  if (progress && !done) progress('封面已传但没自动点「完成」——可在页面手动确认');
  return true;
}

async function injectDouyin(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '抖音还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  // 0) 先清掉拦截弹窗(上次未发布草稿「放弃」、通知「我知道了」),否则挡住上传。
  progress('0/5 关掉拦截弹窗…');
  await dismissDouyinBlockers(wv);

  progress('1/5 上传成片…');
  // 只塞到视频文件输入(accept*=video),别塞到封面的 image 输入。
  const put = await setFiles(wv, draft.filePaths, 'input[type=file][accept*="video"], input[type=file]');
  if (!put.ok) {
    return { ok: false, detail: `成片注入失败(${put.reason ?? '未知'})——请手动拖入(成片文件夹已可从发布步打开)` };
  }

  progress('2/5 等编辑表单就绪…');
  // 标题是 semi-input(placeholder「填写作品标题…」),描述是 contenteditable。
  const formReady = await waitFor(wv, 'input[placeholder*="标题"], input.semi-input, [contenteditable="true"]', 90_000);
  if (!formReady) {
    return { ok: false, detail: '视频已提交但编辑表单没等到——表单出现后手动粘贴标题即可,文案在剪贴板' };
  }
  await sleep(1500);
  await dismissDouyinBlockers(wv); // 表单页也可能弹「我知道了」

  progress('3/5 键入标题/简介…');
  const DY_TITLE_SEL = 'input[placeholder*="标题"], input.semi-input';
  const titleOk =
    (await typeIntoField(wv, DY_TITLE_SEL, draft.title.slice(0, 30)))
    || (await fillInput(wv, DY_TITLE_SEL, draft.title.slice(0, 30)));
  const editorOk =
    (await typeIntoField(wv, '[contenteditable="true"]', draft.title, (pct) => progress(`3/5 键入简介… ${pct}%`)))
    || (await fillEditor(wv, draft.title));
  if (!titleOk && !editorOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  if (editorOk && draft.tags.length > 0) {
    await typeText(wv, ' ');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`3/5 话题 ${i}/${total}…`));
  }
  clickAt(wv, 20, 200);
  await sleep(600);

  // 4) 封面(可选):用户在发布页传的封面 → 自动上传到抖音。失败不阻断存草稿。
  if (draft.coverPath) {
    progress('4/5 上传封面…');
    const coverOk = await uploadDouyinCover(wv, draft.coverPath, progress);
    if (!coverOk) progress('4/5 封面自动上传没成(不阻断)——可在页面手动设置封面');
    await dismissDouyinBlockers(wv);
  }

  progress('5/5 存草稿(暂存离开)…');
  // 抖音的存草稿按钮是「暂存离开」。必须【真实坐标点击】——JS el.click() 触发不了抖音 React 的
  // 保存动作(2026-07-14 实测:填好了但 JS 点击存不上),clickRealByText 走真实鼠标事件。
  const saved =
    (await clickRealByText(wv, ['暂存离开', '存草稿', '保存草稿', '存为草稿']))
    || (await clickSaveDraft(wv));
  await sleep(2500);
  return saved
    ? { ok: true, detail: '已点「暂存离开」存草稿——请在抖音草稿箱/面板里核对,满意后自己发布' }
    : { ok: true, detail: '内容已填好——没自动点到「暂存离开」,请在面板里手动点一下(在右下角)' };
}

// ---- 快手(视频) ----
// 快手创作者中心(cp.kuaishou.com)进上传页时若有未发布作品会弹「还有上次未发布的视频,
// 是否继续编辑?继续编辑/放弃」——不关掉挡住新成片上传。点「放弃」传新的。
async function dismissKuaishouBlockers(wv: DraftWebview): Promise<void> {
  if (await clickByText(wv, ['放弃'])) {
    await sleep(600);
    await clickByText(wv, ['确定', '确认']); // 可能的二次确认
    await sleep(300);
  }
  for (const t of ['我知道了', '知道了']) {
    if (await clickByText(wv, [t])) await sleep(400);
  }
}

// 快手封面自动上传:点「封面设置」→ 打开封面弹层 →(必要时切「上传封面/本地上传」)→ CDP 塞封面图
// 到图片文件输入(accept*=image,实测存在)→ 点「完成/确定」。失败不阻断存草稿。
async function uploadKuaishouCover(wv: DraftWebview, coverPath: string, progress: DraftProgress): Promise<boolean> {
  if (!(await clickRealByText(wv, ['封面设置'])) && !(await clickByText(wv, ['封面设置']))) return false;
  await sleep(1800);
  // 弹层里可能要先切到「上传封面/本地上传」才出文件选择(有的直接塞 image 输入也能触发)。
  await clickByText(wv, ['上传封面', '本地上传', '上传图片', '本地封面', '上传']);
  await sleep(800);
  const put = await setFiles(wv, [coverPath], 'input[type=file][accept*="image"]');
  if (!put.ok) return false;
  await sleep(3500); // 等封面上传 + 预览渲染
  const done =
    (await clickRealByText(wv, ['完成', '确定', '确认', '保存', '使用', '下一步']))
    || (await clickByText(wv, ['完成', '确定', '确认', '保存', '使用', '下一步']));
  await sleep(1500);
  if (progress && !done) progress('封面已传但没自动点「完成」——可在页面手动确认封面');
  return true;
}

async function injectKuaishou(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  // 登录由 runDraftInjection 统一处理(没登录会停前台等扫码)。
  // 0) 关掉「还有上次未发布的视频/继续编辑/放弃」拦截弹窗。
  progress('0/4 关掉拦截弹窗…');
  await dismissKuaishouBlockers(wv);

  progress('1/4 上传成片…');
  const put = await setFiles(wv, draft.filePaths, 'input[type=file][accept*="video"], input[type=file]');
  if (!put.ok) {
    return { ok: false, detail: `成片注入失败(${put.reason ?? '未知'})——请手动拖入(成片文件夹已可从发布步打开)` };
  }

  progress('2/4 等编辑表单就绪…(视频处理较久)');
  // 实测:快手无独立标题框,「作品描述」是 contenteditable(占位「作品描述不会写?…」),
  // 描述即文案。视频处理慢,等长一点。
  const formReady = await waitFor(wv, '[contenteditable="true"]', 120_000);
  if (!formReady) {
    return { ok: false, detail: '视频已提交但编辑表单没等到(可能还在处理)——表单出现后手动粘贴文案即可,文案在剪贴板' };
  }
  await sleep(1500);
  await dismissKuaishouBlockers(wv);

  progress('3/4 键入作品描述…');
  const typed =
    (await typeIntoField(wv, '[contenteditable="true"]', draft.title, (pct) => progress(`3/4 键入描述… ${pct}%`)))
    || (await fillEditor(wv, draft.title));
  if (!typed) {
    return { ok: false, detail: '表单结构对不上(快手可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  if (draft.tags.length > 0) {
    await typeText(wv, ' ');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`3/4 话题 ${i}/${total}…`));
  }
  clickAt(wv, 20, 200);
  await sleep(600);

  // 封面(可选):用户在发布页传的封面 → 自动上传到快手「封面设置」。失败不阻断。
  if (draft.coverPath) {
    progress('封面 · 上传中…');
    const coverOk = await uploadKuaishouCover(wv, draft.coverPath, progress);
    if (!coverOk) progress('封面自动上传没成(不阻断)——可在页面手动设置封面');
    await dismissKuaishouBlockers(wv);
  }
  await sleep(1200); // 停一下让快手自动保存编辑态(它会把上传的作品自动留到草稿箱)

  // 快手【没有独立「存草稿」按钮】(底部只有 发布/取消),上传的作品会自动进「草稿箱」。
  // 铁律:绝不点「发布」。停在发布前一步——成片已传、文案已填,作品已在草稿箱,用户核对后
  // 自己点「发布」,或去「内容管理→草稿」里管理。
  progress('4/4 已填好,停在发布前(快手自动存草稿箱)…');
  return {
    ok: true,
    detail: '已上传成片+填好文案,停在发布前——快手没有独立「存草稿」键,作品已自动进「草稿箱」(内容管理→草稿);核对后你自己点「发布」。',
  };
}

// ---- 知乎(专栏文章) ----
// 选择器移植自 social-auto-upload/uploader/zhihu_uploader(实测校准):
// 写作页 zhuanlan.zhihu.com/write;标题 textarea.WriteIndex-titleInput;
// 正文 DraftJS contenteditable;话题=「添加话题」按钮→搜索框→联想点选。
// 知乎写作页边写边自动存草稿——没有也不需要「存草稿」按钮,天然契合
// 只存草稿铁律;发布永远由用户在页面上自己点。
async function injectZhihu(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '知乎还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  progress('1/4 等编辑器就绪…');
  const ZH_TITLE = "textarea.WriteIndex-titleInput, textarea[placeholder*='标题'], input[placeholder*='标题']";
  const formReady = await waitFor(wv, ZH_TITLE, 30_000);
  if (!formReady) {
    // 注入开始时页面可能还在跳转中(write→signin),此刻补一次登录检测
    // 才能给准确指引。
    if (await isLoginWall(wv)) {
      return { ok: false, detail: '知乎还没登录——在面板里扫码登录后再点一次「一键存草稿」(登录态会长期保持)' };
    }
    return { ok: false, detail: '知乎编辑器没等到——确认面板在「写文章」页(工具条地址 zhuanlan.zhihu.com/write)' };
  }

  // 封面:知乎「添加文章封面」区的独立 input(.UploadPicture-input,
  // 2026-07-09 真实页面探测;accept 仅 jpg/jpeg/png)。
  if (draft.coverPath) {
    progress('2/4 上传封面…');
    const coverPut = await setFiles(wv, [draft.coverPath], 'input.UploadPicture-input, input[type=file][accept=".jpeg, .jpg, .png"]');
    if (coverPut.ok) await sleep(2500);
    else progress('2/4 封面注入失败(不阻断)——可在页面手动补');
  }

  progress('2/4 键入标题…');
  const titleOk =
    (await typeIntoField(wv, ZH_TITLE, draft.title.slice(0, 100)))
    || (await fillInput(wv, ZH_TITLE, draft.title.slice(0, 100)));

  progress('3/4 写入正文…');
  const ZH_EDITOR = "div.public-DraftEditor-content, div[contenteditable='true'][data-contents='true'], [contenteditable='true']";
  const ZH_BODY_IMG_INPUT = 'input[type=file][accept^="image/"][multiple]';
  const segments = draft.segments?.length
    ? draft.segments
    : [{ type: 'text' as const, text: draft.body }];
  // 正文改用「HTML 粘贴」(2026-07-10 用户报 markdown 显字面符号+逐字长文
  // 抢焦点):文本段 markdown→知乎 HTML 一次 paste(DraftJS 解析成真富文本,
  // 标题/加粗/列表全对,几秒完成不抢焦点);图片段仍走 CDP 原位上传本地文件。
  let bodyOk = false;
  const focused = await focusByClick(wv, ZH_EDITOR);
  if (focused) {
    // 双保险清空(同 typeIntoField):重复 handoff 时旧正文必须清干净。
    await clearFieldBySelector(wv, ZH_EDITOR);
    await clearFieldByKeys(wv);
    const total = segments.length;
    for (let i = 0; i < total; i++) {
      const seg = segments[i]!;
      if (seg.type === 'text') {
        progress(`3/4 正文 段${i + 1}/${total}…`);
        const html = markdownToZhihuHtml(seg.text);
        const pasted = await pasteHtmlAtCursor(wv, html, seg.text.replace(/[#*>`]/g, ''));
        if (pasted) bodyOk = true;
        await sleep(600);
      } else {
        progress(`3/4 插入配图(段${i + 1}/${total})…`);
        const before = await editorImageCount(wv);
        const put = await setFiles(wv, [seg.path], ZH_BODY_IMG_INPUT);
        if (put.ok) {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if ((await editorImageCount(wv)) > before) break;
            await sleep(1000);
          }
          await sleep(800);
        } else {
          progress(`3/4 配图注入失败(段${i + 1},不阻断)`);
        }
      }
    }
  } else {
    bodyOk = await pasteHtmlAtCursor(wv, markdownToZhihuHtml(draft.body), draft.body.replace(/[#*>`]/g, ''));
  }
  if (!titleOk && !bodyOk) {
    return { ok: false, detail: '编辑器结构对不上(知乎可能改版了)——文案在剪贴板,请手动粘贴' };
  }

  if (draft.tags.length > 0) {
    progress('4/4 添加话题…');
    for (const tag of draft.tags.slice(0, 3)) {
      const opened = await clickByText(wv, ['添加话题']);
      if (!opened) break;
      await sleep(700);
      const TOPIC_INPUT = "input[placeholder*='搜索话题'], input[placeholder*='话题']";
      if (!(await focusByClick(wv, TOPIC_INPUT))) break;
      await typeText(wv, tag);
      await sleep(1100);
      // 联想下拉点选第一个以话题词开头的候选(防御式:知乎候选结构未内测)。
      const picked = await wvEval<boolean>(
        wv,
        `(() => {
          const want = ${JSON.stringify(tag)};
          const nodes = [...document.querySelectorAll('button, li, [role="option"], .Popover *')];
          const el = nodes.find((n) => n.childElementCount <= 2 && (n.textContent || '').trim().startsWith(want) && n.getClientRects().length > 0 && !n.closest('[contenteditable="true"]'));
          if (!el) return false;
          el.click();
          return true;
        })()`,
      );
      if (!picked) break;
      await sleep(700);
    }
  }

  // 知乎写作页自动保存;稍候确认草稿标记出现。
  await sleep(1800);

  if (draft.autoPublish) {
    progress('发布中…');
    // 知乎「发布」= 一键直发(无二级弹层,实测);真实坐标点击。
    const clicked = await clickRealByText(wv, ['发布']);
    if (!clicked) {
      return { ok: false, detail: '没找到「发布」按钮——内容已键入,请在面板里手动点发布' };
    }
    await sleep(3500);
    const published = await wvEval<boolean>(wv, `/zhihu\\.com\\/p\\/\\d+(?!.*edit)/.test(location.href) || /发布成功|已发布/.test(document.body.innerText)`);
    return {
      ok: true,
      detail: published
        ? '已发布到知乎——文章已公开,可在你的主页查看'
        : '已点发布——请在面板里确认是否发布成功',
    };
  }

  const savedFlag = await wvEval<boolean>(wv, `/(草稿箱|已保存|自动保存|保存于)/.test(document.body.innerText)`);
  return {
    ok: true,
    detail: savedFlag
      ? '已写入知乎草稿(写作页自动保存)——在面板里核对,发布自己点'
      : '内容已键入——知乎写作页会自动存草稿,在面板里核对后自行发布',
  };
}

// ---- 微博(首页发布框) ----
// 真实页面探测(已登录 weibo.com):首页顶部 textarea[placeholder*="新鲜事"]
// 是普通微博发布框,旁边「发送」按钮。铁律:微博发布框没有「存草稿」,
// 所以只真实键入到发布框、绝不点「发送」——把内容备好停在发送前一步,
// 用户核对后自己点发送(对外动作永远人工)。
async function injectWeibo(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '微博还没登录——在面板里登录后再点一次' };
  }
  progress('1/2 定位发布框…');
  const WB_BOX = 'textarea[placeholder*="新鲜事"], textarea[placeholder*="分享"], .Form_input textarea, textarea';
  const ready = await waitFor(wv, WB_BOX, 20_000);
  if (!ready) {
    return { ok: false, detail: '没找到微博发布框——确认面板停在 weibo.com 首页;文案在剪贴板可手动粘贴' };
  }

  progress('2/2 键入正文…');
  // 微博正文=标题+正文合并(普通微博无独立标题),话题以 #词# 形式内联。
  const tagLine = draft.tags.length ? ' ' + draft.tags.map((t) => `#${t}#`).join(' ') : '';
  const text = `${draft.title ? draft.title + '\n' : ''}${draft.body}${tagLine}`.replace(/\n{2,}/g, '\n');
  const typed =
    (await typeIntoField(wv, WB_BOX, text, (pct) => progress(`2/2 键入正文… ${pct}%`)))
    || (await fillInput(wv, WB_BOX, text));
  if (!typed) {
    return { ok: false, detail: '发布框键入失败——文案在剪贴板,请手动粘贴' };
  }

  if (draft.autoPublish) {
    progress('发送中…');
    await sleep(800);
    const clicked = await clickRealByText(wv, ['发送']);
    if (!clicked) {
      return { ok: false, detail: '没找到「发送」按钮——内容已填好,请在面板里手动点发送' };
    }
    await sleep(3000);
    const sent = await wvEval<boolean>(wv, `(() => { const ta = [...document.querySelectorAll('textarea')].find((n) => (n.getAttribute('placeholder')||'').includes('新鲜事')); return !ta || !ta.value.trim(); })()`);
    return {
      ok: true,
      detail: sent ? '已发送到微博——已公开,可在你的主页查看' : '已点发送——请在面板里确认',
    };
  }

  // 非直发:停在发送前一步。
  return {
    ok: true,
    detail: '内容已填进微博发布框(停在发送前)——微博没有草稿箱,核对后你自己点「发送」',
  };
}

// ---- B站(视频投稿·全自动) ----
// B站网页投稿页的上传器(input[name=buploader])【拒绝程序化塞文件】:它是 Vue 响应式组件,CDP
// setFiles 塞进去的文件会被重渲染抹掉(input.files 恒空、不上传),只认真人拖拽/点击弹原生框。所以
// 抖音/快手/小红书那套「注入网页表单」对 B站 无效。改为:导出登录 cookie → 交给 daemon 用 cookie
// 直连 B站 的 upos 上传 API + draft/add 建草稿(见 daemon /bilibili-draft + scripts/bilibili_upload.py)。
// 全程不碰网页上传器,wv 只用于统一登录检测(runDraftInjection 已处理)。
async function injectBilibili(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  const video = draft.filePaths[0] || '';
  if (!video) return { ok: false, detail: 'B站存草稿需要成片视频——请先在「上传」步传成片' };

  progress('1/3 读取B站登录态…');
  // 账号从当前 webview 的分区推导:分区名 persist:od-browser-bilibili-<账号>,登录态就在这个分区里。
  // 之前硬编码 'main' 对不上真实账号分区(如 u9f4c2966)→ 导出为空、报"登录态读取失败"。
  const partition = String(wv.getAttribute('partition') || '');
  const account = partition.replace(/^persist:od-browser-bilibili-/, '') || 'main';
  const cookieFile = await exportBrowserCookies('bilibili', account);
  if (!cookieFile) {
    return { ok: false, detail: 'B站登录态读取失败——请确认已在「账号」页登录B站,再点一次「一键存草稿」' };
  }

  progress('2/3 上传视频到B站(直连官方接口,大视频较慢,请稍候别关)…');
  const tags = draft.tags.join(',');
  const r = await submitBilibiliDraft(video, draft.title, draft.body, tags, cookieFile, draft.coverPath ?? '');
  if ('error' in r) return { ok: false, detail: r.error };

  progress('3/3 完成');
  return { ok: true, detail: '已存到B站草稿箱(投稿管理 → 草稿箱)——核对分区后自己点投稿即可(封面已带上)' };
}

// ---- 视频号(channels.weixin.qq.com·半自动填标题+描述) ----
// 两个硬约束决定了这是【半自动】而非全自动:
//  1. 视频号发布页(platform/post/create)的编辑表单在一个【同源 iframe】里,顶层
//     document.querySelector 够不到——所有填充 JS 必须先钻进 iframe.contentDocument。
//  2. 视频号【拒绝程序化上传视频】(和 B站 一样:CDP setFiles 塞进去的文件被微信重
//     渲染抹掉,input.files 恒空、不触发上传)——所以视频必须【用户手动选文件上传】。
// 因此本适配器只做三件事:轮询等用户把视频传完(编辑表单字段出现)→ 自动填「短标题」
// +「视频描述」→ 视频号【没有草稿箱】,提醒用户自己点「发表」。铁律:绝不点「发表」。

/** 视频号编辑表单是否就绪(顶层或任一同源 iframe 里出现短标题输入框/描述编辑器)。
 *  出现即代表用户已把视频上传成功、进入了编辑态。 */
async function shipinhaoFormReady(wv: DraftWebview): Promise<boolean> {
  const ok = await wvEval<boolean>(
    wv,
    `(() => {
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) {
        try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* 跨域 iframe 跳过 */ }
      }
      return docs.some((d) => d.querySelector('input[placeholder*="短标题"]') || d.querySelector('.input-editor[contenteditable]'));
    })()`,
  );
  return ok === true;
}

/** 在视频号表单里填「短标题」(受控 input:native value setter)+「视频描述」
 *  (contenteditable:优先 execCommand insertText 处理换行,失败退回 textContent)。
 *  两个字段都只在传入非空值时才写,空值只探测不改写(不误清用户已填内容)。 */
async function shipinhaoFillForm(
  wv: DraftWebview,
  shortTitle: string,
  desc: string,
): Promise<{ titleSet: boolean; descSet: boolean }> {
  const r = await wvEval<{ titleSet: boolean; descSet: boolean }>(
    wv,
    `(() => {
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) {
        try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* 跨域 iframe 跳过 */ }
      }
      let d = null;
      for (const doc of docs) {
        if (doc.querySelector('input[placeholder*="短标题"]') || doc.querySelector('.input-editor[contenteditable]')) { d = doc; break; }
      }
      if (!d) return { titleSet: false, descSet: false };
      const win = d.defaultView || window;
      let titleSet = false, descSet = false;
      // 短标题:受控 input,native value setter + input/change(用 iframe 自身 realm 的原型)
      const ti = d.querySelector('input[placeholder*="短标题"]');
      const st = ${JSON.stringify(shortTitle)};
      if (ti && st) {
        const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
        set.call(ti, st);
        ti.dispatchEvent(new win.Event('input', { bubbles: true }));
        ti.dispatchEvent(new win.Event('change', { bubbles: true }));
        titleSet = (ti.value || '').indexOf(st.slice(0, 2)) >= 0;
      }
      // 视频描述:contenteditable。先清空,再插入(insertText 会把 \\n 处理成换行、
      // 并触发微信编辑器的 input 处理);失败退回 textContent + input 事件。
      const ce = d.querySelector('.input-editor[contenteditable]');
      const dv = ${JSON.stringify(desc)};
      if (ce && dv) {
        ce.focus();
        try { const s = win.getSelection(); s.selectAllChildren(ce); d.execCommand('delete'); } catch (e) { /* 清空失败无妨 */ }
        let ok = false;
        try { ok = d.execCommand('insertText', false, dv); } catch (e) { ok = false; }
        if (!ok || !(ce.textContent || '').trim()) {
          ce.textContent = dv;
          ce.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
        }
        descSet = (ce.textContent || '').trim().length > 0;
      }
      return { titleSet, descSet };
    })()`,
  );
  return r ?? { titleSet: false, descSet: false };
}

async function injectShipinhao(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  // 登录由 runDraftInjection 的 waitForLogin 统一处理(视频号登录页 channels…/login 会被识别)。
  const video = draft.filePaths[0] || '';
  // 先【尝试自动上传】:CDP setFiles 通道能跨进视频号发表页的同源 iframe 找到视频输入
  // (embedded-browser 的 performSearch 跨框架搜索)。微信接受→全自动;若微信拒收
  // (个别版本会重渲染抹掉注入的文件)→ 靠下面的提示引导用户手动上传兜底。
  if (video) {
    progress('1/3 提交视频(自动上传)…');
    await setFiles(wv, [video], 'input[type=file][accept*="video"], input[type=file]');
  }
  // 轮询等编辑表单(短标题/描述)出现——出现即代表视频已上传成功、进入编辑态。
  // 自动上传被接受→很快出现;若微信拒收→用户看提示手动传,一并等(选文件+上传+转码,最多 5 分钟)。
  progress('1/3 处理视频中…若下方没在上传,请手动把视频拖入/选择(视频号个别版本会拒绝自动上传)');
  const deadline = Date.now() + 5 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await shipinhaoFormReady(wv)) { ready = true; break; }
    await sleep(2500);
  }
  if (!ready) {
    return {
      ok: false,
      detail: '没等到视频号编辑表单——请确认视频已上传(自动上传没成功时请在下方页面手动拖入视频);传好后再点一次「一键存草稿」,我会自动填短标题和视频描述',
    };
  }

  progress('2/3 自动填写短标题 + 视频描述…');
  // 短标题:视频号规则 6-16 字,过短会标红。取标题前 16 字;不足 6 字则跳过(可选字段,
  // 靠视频描述兜底)。视频描述(=看点标题风格的短文案,与抖音/快手一致用 title)+ 话题标签
  // (视频号 #话题 内联,发表时自动成话题)。
  const stFull = (draft.title || '').trim();
  const shortTitle = stFull.length >= 6 ? stFull.slice(0, 16) : '';
  const tagLine = draft.tags.length ? ' ' + draft.tags.map((t) => `#${t}`).join(' ') : '';
  const descText = (stFull + tagLine).slice(0, 1000);
  // 微信 React 编辑器偶发首次写入被重渲染吃掉,重试一次填充。
  let res = await shipinhaoFillForm(wv, shortTitle, descText);
  if (!res.descSet) {
    await sleep(900);
    res = await shipinhaoFillForm(wv, shortTitle, descText);
  }
  if (!res.titleSet && !res.descSet) {
    return { ok: false, detail: '视频号表单结构对不上(可能改版了)——文案在剪贴板,请手动粘贴到短标题/视频描述' };
  }

  progress('3/3 已填好');
  const filled = [res.titleSet ? '短标题' : '', res.descSet ? '视频描述' : ''].filter(Boolean).join('+');
  return {
    ok: true,
    detail: `已自动填写${filled}——视频号没有草稿箱,请在下方页面核对无误后自己点「发表」发布(发布动作永远由你确认)`,
  };
}

// 百度知道回答注入(W12-B):导航到目标问题页 → 真实点击「我来答」→ UEditor 写入回答。
// 百度知道的"发布"=在相关问题下写回答,不是发独立文章。2026-07-20 真机(鱼尾15 账号)校准:
//   · 「我来答」在 .wgt-replyer-line,【必须真实鼠标点击】(isTrusted;JS click 不触发编辑器实例化);
//   · 点击后 UEditor 实例化进 #answer-editor:iframe#ueditor_0(同源,body contenteditable),
//     页面暴露 window.UE.instants —— setContent(html) 写入最稳(getContent 可读回验证);
//   · 提交按钮 = #answer-editor .new-editor-deliver-btn(「提交回答」,提交即公开发布,不自动点);
//   · 登录态是异步水合的:静态首帧顶栏挂「登录」链接≠未登录,须等水合后再判。
async function injectBaiduZhidao(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  // 目标问题页:建稿时从选题带来(extra.sourceUrl→draft.targetUrl)。没带则要求面板已停在问题页。
  const onQuestionPage = async (): Promise<boolean> =>
    Boolean(await wvEval<boolean>(wv, `/\\/question\\//.test(location.pathname)`));
  if (draft.targetUrl && /\/question\//.test(draft.targetUrl)) {
    progress('1/4 打开目标问题页…');
    await wvEval(wv, `location.href = ${JSON.stringify(draft.targetUrl)}`);
    await sleep(4500);
  }
  if (!(await onQuestionPage())) {
    return { ok: false, detail: '不在问题页——从「选题」选一个问题建稿(问题链接会随稿带上),或在面板里先打开要回答的问题' };
  }
  // 登录判定:等水合(顶栏用户名异步渲染),再看是否仍挂着可见「登录」链接。
  progress('1/4 等页面就绪…');
  await waitFor(wv, '.wgt-replyer-line', 20_000);
  await sleep(2500);
  const loggedOut = await wvEval<boolean>(
    wv,
    `(() => { const a=[...document.querySelectorAll('a')].find(x=>{const t=(x.textContent||'').trim(); const r=x.getBoundingClientRect(); return t==='登录'&&r.width>0&&r.top<80;}); return Boolean(a); })()`,
  );
  if (loggedOut) {
    return { ok: false, detail: '百度知道还没登录——在面板里登录百度账号后再点一次' };
  }
  progress('2/4 点开「我来答」…');
  // 已有编辑器(重复注入)就不用再点;否则真实鼠标点击(JS click 无效,反爬认 isTrusted)。
  // 【必须点 .wgt-replyer-line 里那个】——页面顶部另有同文案的滚动锚点(span.smooth),点了不
  // 实例化编辑器;真机校准确认答题入口是 replyer-line 内的按钮。
  const hasEditor = async (): Promise<boolean> =>
    Boolean(await wvEval<boolean>(wv, `Boolean(document.querySelector('#ueditor_0'))`));
  // 页面 JS 绑定入口按钮的时机偏晚(水合后几秒),点太早=没反应。故【循环点击】:
  // 每轮 定位→滚到中心→稳定→真点→等 2.5s 看编辑器出没出,最多 6 轮(~20s)。
  const REPLYER_BTN_POS = `(() => {
    const line = document.querySelector('.wgt-replyer-line');
    if (!line) return null;
    const btn = [...line.querySelectorAll('*')].find((e) => {
      const t = (e.textContent || '').trim();
      return /我来答|写回答/.test(t) && t.length <= 6 && e.getBoundingClientRect().width > 0;
    }) || line;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
  for (let round = 0; round < 6 && !(await hasEditor()); round++) {
    await wvEval(wv, REPLYER_BTN_POS); // 先滚到中心
    await sleep(650);
    const pos = await wvEval<{ x: number; y: number } | null>(wv, REPLYER_BTN_POS); // 稳定后重取坐标
    if (!pos) { await sleep(1200); continue; }
    await humanClickAt(wv, pos.x, pos.y);
    await sleep(2500);
  }
  if (!(await hasEditor())) {
    return { ok: false, detail: '回答编辑器没打开——手动点一下页面上的「我来答」再重试' };
  }
  progress('3/4 写入回答…');
  // UEditor 官方 API 写入(同源):setContent(html) → getContent 回读验证。markdown→HTML 复用知乎渲染。
  const textMd = (draft.segments?.length ? draft.segments : [{ type: 'text' as const, text: draft.body }])
    .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
    .map((s) => s.text)
    .join('\n\n');
  const html = markdownToZhihuHtml(textMd);
  const wrote = await wvEval<boolean>(
    wv,
    `(() => { try {
      const ue = window.UE; if (!ue || !ue.instants) return false;
      const keys = Object.keys(ue.instants); if (!keys.length) return false;
      const inst = ue.instants[keys[0]];
      inst.setContent(${JSON.stringify(html)});
      return (inst.getContent() || '').length > 0;
    } catch (e) { return false; } })()`,
  );
  if (!wrote) {
    // 兜底:直接写 iframe body(同源;UEditor 提交时从 iframe DOM 取内容)。
    const fallback = await wvEval<boolean>(
      wv,
      `(() => { try {
        const f = document.querySelector('#ueditor_0'); const b = f && f.contentDocument && f.contentDocument.body;
        if (!b) return false; b.innerHTML = ${JSON.stringify(html)}; return true;
      } catch (e) { return false; } })()`,
    );
    if (!fallback) return { ok: false, detail: '回答写入失败——可手动把内容粘进回答框' };
  }
  progress('4/4 回答已写入——核对后点「提交回答」发布');
  return { ok: true, detail: '回答已写进编辑框(未提交)——在页面核对后点「提交回答」即公开发布' };
}

const ADAPTERS: Record<string, (wv: DraftWebview, d: DraftPayload, p: DraftProgress) => Promise<DraftResult>> = {
  xiaohongshu: injectXiaohongshu,
  douyin: injectDouyin,
  kuaishou: injectKuaishou,
  bilibili: injectBilibili,
  zhihu: injectZhihu,
  weibo: injectWeibo,
  'baidu-zhidao': injectBaiduZhidao,
  // 视频号:内容平台 id 叫 shipinhao,短视频台/sau 发布链叫 tencent——两个键都指同一后台。
  tencent: injectShipinhao,
  shipinhao: injectShipinhao,
};

export function draftInjectionSupported(platform: string): boolean {
  return platform in ADAPTERS;
}

const DRAFT_PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', bilibili: 'B站', zhihu: '知乎', weibo: '微博',
  'baidu-zhidao': '百度知道',
  tencent: '视频号', shipinhao: '视频号',
};
// 各平台发布页 URL(与 daemon media-studio/browser.ts 对齐):登录成功后导回这里再注入。
const DRAFT_PUBLISH_URL: Record<string, string> = {
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  kuaishou: 'https://cp.kuaishou.com/article/publish/video',
  bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
  zhihu: 'https://zhuanlan.zhihu.com/write',
  weibo: 'https://weibo.com',
  // 百度知道无固定"写"页(答案在具体问题下),登录/兜底用主站;真发时导航到目标问题页。
  'baidu-zhidao': 'https://zhidao.baidu.com/',
  tencent: 'https://channels.weixin.qq.com/platform/post/create',
  shipinhao: 'https://channels.weixin.qq.com/platform/post/create',
};

/**
 * 【统一登录引导】没登录时把登录页停在前台,给醒目提示,等用户扫码登录(最多 5 分钟),登录后
 * 导回发布页再继续注入——所有平台一致(2026-07-14 用户:没登录要引导去登录)。返回是否已登录。
 */
async function waitForLogin(wv: DraftWebview, platform: string, label: string, progress: DraftProgress): Promise<boolean> {
  if (!(await isLoginWall(wv))) return true;
  progress(`⚠️ ${label}还没登录——请在下方页面扫码登录,登录后自动继续存草稿(我会一直等你,最多5分钟)`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await isLoginWall(wv))) {
      // 登录后页面常停在登录成功页/平台首页,导回发布页再让适配器接手。
      const url = DRAFT_PUBLISH_URL[platform];
      if (url) {
        try { await wv.executeJavaScript(`location.href=${JSON.stringify(url)}`); } catch { /* ignore */ }
        await sleep(3500);
      }
      progress(`✓ ${label}已登录,继续存草稿…`);
      return true;
    }
  }
  return false;
}

export async function runDraftInjection(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  const adapter = ADAPTERS[draft.platform];
  if (!adapter) {
    return { ok: false, detail: `「${draft.platform}」暂不支持自动填稿——文案在剪贴板,请手动粘贴` };
  }
  const label = DRAFT_PLATFORM_LABEL[draft.platform] ?? draft.platform;
  try {
    // 先统一处理登录:没登录就停前台等用户扫码,登录后自动继续;超时才引导去账号页。
    if (!(await waitForLogin(wv, draft.platform, label, progress))) {
      return { ok: false, detail: `${label}还没登录——请去左侧「账号」页给${label}添加账号并扫码登录,再回来点一次「一键存草稿」` };
    }
    return await adapter(wv, draft, progress);
  } catch (err) {
    return { ok: false, detail: `自动填稿中断(${err instanceof Error ? err.message : String(err)})——文案在剪贴板,请手动接手` };
  }
}
