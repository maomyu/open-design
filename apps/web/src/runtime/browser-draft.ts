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
  kind: 'images' | 'video' | 'article';
  /** article 专用:正文按图片位置切分的段序列——文本段真实键入,图片段
   *  在原位 CDP 插入(知乎正文图 input 常驻,插到光标处)。 */
  segments?: Array<{ type: 'text'; text: string } | { type: 'image'; path: string }>;
  /** article 专用:封面图本机绝对路径(知乎「添加文章封面」区)。 */
  coverPath?: string;
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

/** 真实回车(keyDown + char\r + keyUp)。 */
function pressEnter(wv: DraftWebview): void {
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wv.sendInputEvent({ type: 'char', keyCode: '\r' });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
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
async function clickRealByText(wv: DraftWebview, texts: string[]): Promise<boolean> {
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
  // 正文与标签分开:正文逐字键入;标签走「#词+联想弹层回车」确认成
  // 真话题实体(纯拼在正文里只是文本,不是话题)。
  const bodyOk =
    (await typeIntoField(wv, '[contenteditable="true"]', draft.body, (pct) => progress(`4/5 键入正文… ${pct}%`)))
    || (await fillEditor(wv, draft.body));
  if (!titleOk && !bodyOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴;把这个情况反馈给我们跟修' };
  }
  if (bodyOk && draft.tags.length > 0) {
    // 光标此刻在正文末尾;空一段再逐个上话题。
    await typeText(wv, '\n');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`4/5 话题 ${i}/${total}…`));
  }
  // 点页面空白处收残留联想弹层(真实点击),它会挡底部「存草稿」。
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
  const DY_TITLE_SEL = 'input[placeholder*="标题"], input[placeholder*="作品标题"]';
  const titleOk =
    (await typeIntoField(wv, DY_TITLE_SEL, draft.title.slice(0, 30)))
    || (await fillInput(wv, DY_TITLE_SEL, draft.title.slice(0, 30)));
  const editorOk =
    (await typeIntoField(wv, '[contenteditable="true"]', draft.title, (pct) => progress(`3/4 键入简介… ${pct}%`)))
    || (await fillEditor(wv, draft.title));
  if (!titleOk && !editorOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  if (editorOk && draft.tags.length > 0) {
    // 简介末尾逐个话题:#词 + 联想弹层回车确认成真话题实体。
    await typeText(wv, ' ');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`3/4 话题 ${i}/${total}…`));
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
  const typed =
    (await typeIntoField(wv, KS_FIELD_SEL, draft.title, (pct) => progress(`3/4 键入描述… ${pct}%`)))
    || (await fillInput(wv, 'input[placeholder*="标题"], textarea[placeholder*="描述"]', draft.title))
    || (await fillEditor(wv, draft.title));
  if (!typed) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  if (draft.tags.length > 0) {
    await typeText(wv, ' ');
    await typeHashtags(wv, draft.tags, (i, total) => progress(`3/4 话题 ${i}/${total}…`));
  }
  clickAt(wv, 20, 200);
  await sleep(600);

  progress('4/4 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到快手草稿——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已填好——没找到「存草稿」按钮,请在面板里手动点一下保存' };
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

  progress('3/4 键入正文…');
  const ZH_EDITOR = "div.public-DraftEditor-content, div[contenteditable='true'][data-contents='true'], [contenteditable='true']";
  // 知乎正文图片 input 常驻 DOM(multiple,插到当前光标处;真实页面探测):
  // 区别于文档 input(accept 含 .pdf)与封面 input(非 multiple)。
  const ZH_BODY_IMG_INPUT = 'input[type=file][accept^="image/"][multiple]';
  let bodyOk: boolean;
  const segments = draft.segments?.length
    ? draft.segments
    : [{ type: 'text' as const, text: draft.body }];
  // 分段:文本段真实键入;图片段在光标原位 CDP 插入,等编辑器 img 数+1。
  const focused = await focusByClick(wv, ZH_EDITOR);
  if (focused) {
    await clearFieldByKeys(wv);
    bodyOk = true;
    const total = segments.length;
    for (let i = 0; i < total; i++) {
      const seg = segments[i]!;
      if (seg.type === 'text') {
        // 知乎 DraftJS 一次回车即新段落(自带段间距):markdown 的空行分隔
        // (\n\n)照打会产生空段落——压成单回车(2026-07-10 用户报空行多)。
        const zhText = seg.text.replace(/\n{2,}/g, '\n');
        await typeText(wv, zhText, (pct) => progress(`3/4 正文 段${i + 1}/${total}… ${pct}%`));
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
          // 图片插入后光标落在图后新段;稍候再继续键入。
          await sleep(800);
        } else {
          progress(`3/4 配图注入失败(段${i + 1},不阻断)`);
        }
      }
    }
  } else {
    bodyOk = await fillEditor(wv, draft.body.replace(/\n{2,}/g, '\n'));
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

const ADAPTERS: Record<string, (wv: DraftWebview, d: DraftPayload, p: DraftProgress) => Promise<DraftResult>> = {
  xiaohongshu: injectXiaohongshu,
  douyin: injectDouyin,
  kuaishou: injectKuaishou,
  zhihu: injectZhihu,
  weibo: injectWeibo,
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
