// 评论回复注入器 —— 在内置浏览器 webview 里对一条笔记做「自动评论回复」。
//
// 复用 browser-draft 的拟人原语(真鼠标点击、逐字真键入、换气停顿),这对「评论区高频发言不被
// 风控」至关重要——JS 合成事件会被识别为脚本。一级评论=在笔记底部评论框输入发送;楼中楼=先点
// 目标评论的「回复」展开楼中楼输入框再发。发送是外发动作,受 daemon 端风控台账(W1)门控。
import {
  wvEval,
  focusByClick,
  typeText,
  clickRealByText,
  type DraftWebview,
} from './browser-draft';
import { buildNoteUrl, COMMENT_LOGIN_WALL, type CommentPlatform } from './comment-extractors';
import type { InteractionAction } from '@open-design/contracts';

export interface ReplyInjectSpec {
  platform: string;
  action: InteractionAction; // 'reply'(一级) | 'sub-reply'(楼中楼) | 'dm'(私信,后续 W18)
  /** 一级=笔记 URL/id;楼中楼=父评论 id(在笔记页内定位那条评论)。 */
  targetRef: string;
  text: string;
}

export interface ReplyInjectResult {
  ok: boolean;
  detail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ready(wv: DraftWebview): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const state = await wvEval<string>(wv, 'document.readyState');
    if (state === 'complete' || state === 'interactive') break;
    await sleep(700);
  }
  await sleep(1500);
}

/** 判是否登录墙(评论区被登录挡住)。 */
async function loginWalled(wv: DraftWebview, platform: CommentPlatform): Promise<boolean> {
  const walls = COMMENT_LOGIN_WALL[platform] ?? [];
  const body = (await wvEval<string>(wv, 'document.body ? document.body.innerText.slice(0,3000) : ""')) || '';
  return walls.some((w) => body.includes(w)) && body.replace(/\s/g, '').length < 200;
}

/**
 * 小红书评论回复。一级评论:点底部评论框→逐字键入→点发送。楼中楼:先点目标父评论的「回复」
 * 展开其楼中楼输入框(输入框会带 @对方),再键入发送。选择器给多候选,改版优先只调这里。
 */
async function injectXhsReply(
  wv: DraftWebview,
  spec: ReplyInjectSpec,
  say: (m: string) => void,
): Promise<ReplyInjectResult> {
  const noteUrl = buildNoteUrl('xiaohongshu', spec.action === 'sub-reply' ? '' : spec.targetRef);
  // 一级评论:targetRef 是笔记链接,导航过去;楼中楼:调用方已在笔记页,targetRef 是父评论 id。
  if (noteUrl) {
    say('打开笔记页…');
    await wvEval(wv, `location.href = ${JSON.stringify(noteUrl)}`);
    await ready(wv);
  }
  if (await loginWalled(wv, 'xiaohongshu')) return { ok: false, detail: '未登录:请在标签里扫码登录后重试' };

  // 楼中楼:先在笔记页内定位父评论,点它的「回复」展开楼中楼输入框。
  if (spec.action === 'sub-reply') {
    say('定位父评论并展开楼中楼回复框…');
    const opened = await wvEval<boolean>(wv, `(() => {
      const id = ${JSON.stringify(spec.targetRef)};
      const items = document.querySelectorAll('.parent-comment, .comment-item');
      for (const it of items) {
        const hit = (it.getAttribute('data-comment-id') === id) || (it.id === id) || it.querySelector('[data-comment-id="'+id+'"]');
        if (hit) {
          const btn = it.querySelector('.reply, .reply-btn, [class*="reply"]');
          if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        }
      }
      return false;
    })()`);
    if (!opened) return { ok: false, detail: '没找到父评论的「回复」入口(评论可能已加载不全或被折叠)' };
    await sleep(1200);
  } else {
    // 一级评论:滚到评论区底部,让底部评论框可点。
    await wvEval(wv, 'window.scrollTo(0, document.body.scrollHeight)');
    await sleep(900);
  }

  // 定位并聚焦评论输入框(小红书是 contenteditable;给多候选)。
  say('点开评论框…');
  const INPUT_SELS = [
    '.comment-input .content-input',
    '.content-input',
    '.comment-input [contenteditable="true"]',
    '.engage-bar [contenteditable="true"]',
    '.input-box [contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea',
    'p.content-edit',
  ];
  let focused = false;
  for (const sel of INPUT_SELS) {
    if (await focusByClick(wv, sel)) { focused = true; break; }
  }
  if (!focused) {
    // 有些主题下需先点「说点什么」占位条唤起输入框,再聚焦。
    await clickRealByText(wv, ['说点什么', '说点什么...', '说点什么吧', '写评论', '留下你的评论']);
    await sleep(800);
    for (const sel of INPUT_SELS) {
      if (await focusByClick(wv, sel)) { focused = true; break; }
    }
  }
  if (!focused) return { ok: false, detail: '没找到评论输入框(选择器需按真实页面校准)' };

  say('拟人输入回复…');
  await typeText(wv, spec.text, undefined, { slow: true });
  await sleep(600);

  say('发送…');
  const sent = await clickRealByText(wv, ['发送', '发布', '回复']);
  if (!sent) return { ok: false, detail: '输入成功但没找到「发送」按钮(可能需回车发送或按钮文案不同)' };
  await sleep(1200);
  return { ok: true, detail: `已回复:${spec.text.slice(0, 20)}${spec.text.length > 20 ? '…' : ''}` };
}

const INJECTORS: Record<string, (wv: DraftWebview, spec: ReplyInjectSpec, say: (m: string) => void) => Promise<ReplyInjectResult>> = {
  xiaohongshu: injectXhsReply,
};

export function replyInjectionSupported(platform: string): boolean {
  return platform in INJECTORS;
}

/** 派发到对应平台的回复注入器。未支持平台明确返回错误(不静默)。 */
export async function runReplyInjection(
  wv: DraftWebview | null,
  spec: ReplyInjectSpec,
  say: (m: string) => void,
): Promise<ReplyInjectResult> {
  if (!wv) return { ok: false, detail: '面板 webview 未就绪' };
  const fn = INJECTORS[spec.platform];
  if (!fn) return { ok: false, detail: `「${spec.platform}」的自动回复暂未接入(当前仅小红书)` };
  try {
    return await fn(wv, spec, say);
  } catch (err) {
    return { ok: false, detail: `回复注入异常:${err instanceof Error ? err.message : String(err)}` };
  }
}
