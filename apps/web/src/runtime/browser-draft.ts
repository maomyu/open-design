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

export interface DraftPayload {
  /** 目标平台 id(xiaohongshu/douyin/...)。 */
  platform: string;
  title: string;
  body: string;
  /** 不带 # 的标签词。 */
  tags: string[];
  /** 本机文件绝对路径(图集按序/成片)。 */
  filePaths: string[];
  kind: 'images' | 'video';
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

async function wvEval<T>(wv: DraftWebview, code: string): Promise<T | null> {
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
async function waitFor(wv: DraftWebview, selector: string, timeoutMs: number): Promise<boolean> {
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

/** 找到可见元素并滚到视野中央,返回视口矩形。 */
async function rectOf(wv: DraftWebview, selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return wvEval<{ x: number; y: number; w: number; h: number } | null>(
    wv,
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.getClientRects().length > 0);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`,
  );
}

function clickAt(wv: DraftWebview, x: number, y: number): void {
  wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/** 真实鼠标点击目标元素完成聚焦(不用 el.focus() 合成路径)。 */
async function focusByClick(wv: DraftWebview, selector: string): Promise<boolean> {
  const r = await rectOf(wv, selector);
  if (!r || r.w < 4) return false;
  // 点前部而非正中心:输入框中央可能盖着 placeholder 联想图标。
  clickAt(wv, Math.round(r.x + Math.min(r.w / 2, 60)), Math.round(r.y + r.h / 2));
  await sleep(280 + Math.random() * 160);
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

/** 逐字真实键入(char 事件);onProgress 按 10% 步长回报。
 *  必须按「字素」迭代而非 UTF-16 码元:emoji(📌⚠️)是代理对/组合序列,
 *  按码元拆开发 char 会撕成两个孤立代理,页面渲染成 ��(2026-07-09 用户
 *  报草稿乱码)。emoji 字素走 insertText 整体插入——真人输入 emoji 也是
 *  从表情面板「选」而不是「打」,行为模式反而更真实。 */
async function typeText(wv: DraftWebview, text: string, onProgress?: (percent: number) => void): Promise<void> {
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
    await sleep(humanDelay(g));
    const pct = Math.floor(((i + 1) / graphemes.length) * 10) * 10;
    if (onProgress && pct !== lastReported && pct > 0) {
      lastReported = pct;
      onProgress(pct);
    }
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
  await clearFieldByKeys(wv);
  await typeText(wv, text, onProgress);
  await sleep(200);
  return true;
}

async function setFiles(wv: DraftWebview, files: string[]): Promise<{ ok: boolean; reason?: string }> {
  const result = await setHostBrowserFileInput({
    webContentsId: wv.getWebContentsId(),
    selector: 'input[type=file]',
    files,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
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

// ---- 小红书(图文) ----
async function injectXiaohongshu(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '小红书还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  progress('1/5 切换到「上传图文」…');
  await clickByText(wv, ['上传图文']);
  await sleep(1200);

  progress(`2/5 上传 ${draft.filePaths.length} 张图…`);
  const put = await setFiles(wv, draft.filePaths);
  if (!put.ok) {
    return { ok: false, detail: `图片注入失败(${put.reason ?? '未知'})——请手动拖入(图集文件夹已可从发布步打开)` };
  }

  progress('3/5 等编辑表单就绪…');
  // 图传完后小红书才渲染标题/正文表单;等标题框出现。
  const formReady = await waitFor(wv, 'input[placeholder*="标题"], input[placeholder*="填写标题"]', 60_000);
  if (!formReady) {
    return { ok: false, detail: '图片已提交但编辑表单没等到(可能还在处理)——表单出现后手动粘贴文案即可,文案在剪贴板' };
  }

  progress('4/5 键入标题…');
  // 真实键入(系统级输入管线,带打字节奏);失败退回合成填充兜底。
  const TITLE_SEL = 'input[placeholder*="标题"], input[placeholder*="填写标题"]';
  const titleOk =
    (await typeIntoField(wv, TITLE_SEL, draft.title.slice(0, 20)))
    || (await fillInput(wv, TITLE_SEL, draft.title.slice(0, 20)));
  const bodyText = `${draft.body}${draft.tags.length ? `\n\n${draft.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
  const bodyOk =
    (await typeIntoField(wv, '[contenteditable="true"]', bodyText, (pct) => progress(`4/5 键入正文… ${pct}%`)))
    || (await fillEditor(wv, bodyText));
  if (!titleOk && !bodyOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴;把这个情况反馈给我们跟修' };
  }
  // 点页面空白处收话题联想弹层(真实点击),它会挡底部「存草稿」。
  clickAt(wv, 20, 200);
  await sleep(600);

  progress('5/5 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到小红书草稿箱——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已全部填好——没找到「存草稿」按钮(可能改版),请在面板里手动点一下暂存/发布' };
}

// ---- 抖音(视频) ----
async function injectDouyin(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '抖音还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  progress('1/4 上传成片…');
  const put = await setFiles(wv, draft.filePaths);
  if (!put.ok) {
    return { ok: false, detail: `成片注入失败(${put.reason ?? '未知'})——请手动拖入(成片文件夹已可从发布步打开)` };
  }

  progress('2/4 等编辑表单就绪…');
  const formReady = await waitFor(wv, 'input[placeholder*="标题"], input[placeholder*="作品标题"], [contenteditable="true"]', 90_000);
  if (!formReady) {
    return { ok: false, detail: '视频已提交但编辑表单没等到——表单出现后手动粘贴标题即可,文案在剪贴板' };
  }

  progress('3/4 键入标题/简介…');
  const text = `${draft.title}${draft.tags.length ? ` ${draft.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
  const DY_TITLE_SEL = 'input[placeholder*="标题"], input[placeholder*="作品标题"]';
  const titleOk =
    (await typeIntoField(wv, DY_TITLE_SEL, draft.title.slice(0, 30)))
    || (await fillInput(wv, DY_TITLE_SEL, draft.title.slice(0, 30)));
  const editorOk =
    (await typeIntoField(wv, '[contenteditable="true"]', text, (pct) => progress(`3/4 键入简介… ${pct}%`)))
    || (await fillEditor(wv, text));
  if (!titleOk && !editorOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  clickAt(wv, 20, 200);
  await sleep(600);

  progress('4/4 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到抖音草稿——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已填好——没找到「存草稿」按钮,请在面板里手动点一下保存' };
}

// ---- 快手(视频) ----
async function injectKuaishou(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  if (await isLoginWall(wv)) {
    return { ok: false, detail: '快手还没登录——在面板里登录后再点一次「一键存草稿」' };
  }
  progress('1/4 上传成片…');
  const put = await setFiles(wv, draft.filePaths);
  if (!put.ok) {
    return { ok: false, detail: `成片注入失败(${put.reason ?? '未知'})——请手动拖入(成片文件夹已可从发布步打开)` };
  }

  progress('2/4 等编辑表单就绪…');
  const KS_FIELD_SEL = 'input[placeholder*="标题"], [contenteditable="true"], textarea[placeholder*="描述"]';
  const formReady = await waitFor(wv, KS_FIELD_SEL, 90_000);
  if (!formReady) {
    return { ok: false, detail: '视频已提交但编辑表单没等到——表单出现后手动粘贴标题即可,文案在剪贴板' };
  }

  progress('3/4 键入标题/描述…');
  const text = `${draft.title}${draft.tags.length ? ` ${draft.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
  const typed =
    (await typeIntoField(wv, KS_FIELD_SEL, text, (pct) => progress(`3/4 键入描述… ${pct}%`)))
    || (await fillInput(wv, 'input[placeholder*="标题"], textarea[placeholder*="描述"]', text))
    || (await fillEditor(wv, text));
  if (!typed) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  clickAt(wv, 20, 200);
  await sleep(600);

  progress('4/4 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到快手草稿——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已填好——没找到「存草稿」按钮,请在面板里手动点一下保存' };
}

const ADAPTERS: Record<string, (wv: DraftWebview, d: DraftPayload, p: DraftProgress) => Promise<DraftResult>> = {
  xiaohongshu: injectXiaohongshu,
  douyin: injectDouyin,
  kuaishou: injectKuaishou,
};

export function draftInjectionSupported(platform: string): boolean {
  return platform in ADAPTERS;
}

export async function runDraftInjection(wv: DraftWebview, draft: DraftPayload, progress: DraftProgress): Promise<DraftResult> {
  const adapter = ADAPTERS[draft.platform];
  if (!adapter) {
    return { ok: false, detail: `「${draft.platform}」暂不支持自动填稿——文案在剪贴板,请手动粘贴` };
  }
  try {
    return await adapter(wv, draft, progress);
  } catch (err) {
    return { ok: false, detail: `自动填稿中断(${err instanceof Error ? err.message : String(err)})——文案在剪贴板,请手动接手` };
  }
}
