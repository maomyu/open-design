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

async function setFiles(wv: DraftWebview, files: string[]): Promise<{ ok: boolean; reason?: string }> {
  const result = await setHostBrowserFileInput({
    webContentsId: wv.getWebContentsId(),
    selector: 'input[type=file]',
    files,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** 只点「存草稿」类按钮——白名单文案,绝不含「发布」。按钮可能在图片
 *  处理完/弹层收起后才可点,重试轮询最多 6 次。 */
async function clickSaveDraft(wv: DraftWebview): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const ok = await clickByText(wv, ['存草稿', '暂存离开', '保存草稿', '保存离开', '存为草稿']);
    if (ok) return true;
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

  progress('4/5 填标题与正文…');
  const titleOk = await fillInput(wv, 'input[placeholder*="标题"], input[placeholder*="填写标题"]', draft.title.slice(0, 20));
  const bodyText = `${draft.body}${draft.tags.length ? `\n\n${draft.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
  const bodyOk = await fillEditor(wv, bodyText);
  if (!titleOk && !bodyOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴;把这个情况反馈给我们跟修' };
  }
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

  progress('3/4 填标题/简介…');
  const text = `${draft.title}${draft.tags.length ? ` ${draft.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
  const titleOk = await fillInput(wv, 'input[placeholder*="标题"], input[placeholder*="作品标题"]', draft.title.slice(0, 30));
  const editorOk = await fillEditor(wv, text);
  if (!titleOk && !editorOk) {
    return { ok: false, detail: '表单结构对不上(平台可能改版了)——文案在剪贴板,请手动粘贴' };
  }
  await sleep(600);

  progress('4/4 存草稿…');
  const saved = await clickSaveDraft(wv);
  return saved
    ? { ok: true, detail: '已存到抖音草稿——在面板里核对,满意后自己点发布' }
    : { ok: true, detail: '内容已填好——没找到「存草稿」按钮,请在面板里手动点一下保存' };
}

const ADAPTERS: Record<string, (wv: DraftWebview, d: DraftPayload, p: DraftProgress) => Promise<DraftResult>> = {
  xiaohongshu: injectXiaohongshu,
  douyin: injectDouyin,
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
