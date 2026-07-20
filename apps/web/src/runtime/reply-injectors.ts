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
  /** 楼中楼:要打开的笔记 URL(targetRef 为父评论 id)。一级评论省略即用 targetRef 当页面。 */
  noteRef?: string;
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
  // 要打开的笔记:楼中楼用 noteRef(targetRef 是父评论 id);一级评论用 targetRef(即笔记链接)。
  const pageRef = spec.action === 'sub-reply' ? (spec.noteRef ?? '') : spec.targetRef;
  const noteUrl = buildNoteUrl('xiaohongshu', pageRef);
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

/**
 * 百度知道评论回复(W14,2026-07-20 真机校准)。评论挂在【每条回答】下,默认折叠:
 * 先点回答页脚「评论(N)」(span.comment)展开 → 评论条 .comment-area .comment-item
 * (.details 作者+日期 / .comment-content 正文 / .operation-con 里有「回复」)。
 * 楼中楼:点目标评论的「回复」→ 弹出该评论专属 mini-editor(textarea)→ 键入 → 点它旁边的
 * 「发表」。一级评论:第一个展开评论区顶部的公共 textarea(「发表意见,抢占沙发」)→ 发表。
 * 评论 id 无 data 属性 → 与提取器同公式合成(作者+正文),两侧才能对上。
 */
async function injectBaiduReply(
  wv: DraftWebview,
  spec: ReplyInjectSpec,
  say: (m: string) => void,
): Promise<ReplyInjectResult> {
  const pageRef = spec.action === 'sub-reply' ? (spec.noteRef ?? '') : spec.targetRef;
  const url = buildNoteUrl('baidu-zhidao', pageRef);
  if (url) {
    say('打开问题页…');
    await wvEval(wv, `location.href = ${JSON.stringify(url)}`);
    await ready(wv);
    await sleep(2000); // 登录态/页脚按钮异步水合
  }
  // 登录判定:顶栏可见「登录」链接=未登录(发评论要登录)。
  const loggedOut = await wvEval<boolean>(
    wv,
    `(() => { const a=[...document.querySelectorAll('a')].find(x=>{const t=(x.textContent||'').trim(); const r=x.getBoundingClientRect(); return t==='登录'&&r.width>0&&r.top<80;}); return Boolean(a); })()`,
  );
  if (loggedOut) return { ok: false, detail: '百度知道未登录——在账号页登录百度账号后重试' };

  // 展开评论区:有评论数的「评论(N)」都点开(楼中楼要在里面找目标评论);一级评论至少开一个框。
  // 百度的按钮处理器【绑定偏晚】(页面水合后好几秒;真机教训同「我来答」):点太早没反应。
  // 故循环:每轮点一遍 → 等 → 查评论区是否真渲染出来(sub-reply 看 .comment-item;一级看 textarea),
  // 出来才继续,最多 6 轮(~14s)。
  say('展开评论区…');
  const expandedSel = spec.action === 'sub-reply' ? '.comment-area .comment-item' : '.comment-area textarea';
  let expanded = false;
  for (let round = 0; round < 6 && !expanded; round++) {
    await wvEval(wv, `(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const btns=[...document.querySelectorAll('span.comment')].filter(b=>b.getBoundingClientRect().width>0);
      const withN=btns.filter(b=>/评论\\s*\\(\\d+\\)/.test((b.textContent||'').trim()));
      const targets=(${spec.action === 'sub-reply' ? 'withN' : '(withN.length?withN:btns)'}).slice(0,4);
      for (const b of targets) { try { b.scrollIntoView({block:'center'}); b.click(); } catch(e){} await sleep(500); }
      return targets.length;
    })()`);
    await sleep(1700);
    expanded = Boolean(await wvEval<boolean>(wv, `Boolean(document.querySelector(${JSON.stringify(expandedSel)}))`));
  }
  if (!expanded) return { ok: false, detail: '评论区没展开(「评论」按钮点了没反应)——稍后重试' };

  if (spec.action === 'sub-reply') {
    // 定位目标评论(合成 id 同提取器公式)→ 点它的「回复」弹出专属输入框。
    say('定位目标评论,点开「回复」…');
    const opened = await wvEval<boolean>(wv, `(() => {
      const synthId=(a,t)=>'c_'+(a+'_'+t).replace(/\\s+/g,'').slice(0,24);
      const want=${JSON.stringify(spec.targetRef)};
      for (const it of document.querySelectorAll('.comment-area .comment-item')) {
        const details=(it.querySelector('.details')&&it.querySelector('.details').innerText||'').trim();
        const text=(it.querySelector('.comment-content')&&it.querySelector('.comment-content').innerText||'').trim().slice(0,500);
        const dm=details.match(/(\\d{4}-\\d{2}-\\d{2}[^]*)$/);
        const author=(dm?details.slice(0,dm.index):details).trim().slice(0,40);
        if (synthId(author,text)===want) {
          const btn=[...it.querySelectorAll('a,span')].find(e=>(e.textContent||'').trim()==='回复');
          if (btn) { it.scrollIntoView({block:'center'}); btn.click(); return true; }
        }
      }
      return false;
    })()`);
    if (!opened) return { ok: false, detail: '没找到目标评论的「回复」入口(评论可能被折叠或已删除)' };
    await sleep(1500);
  }

  // 聚焦输入框:楼中楼=点「回复」后新弹出的 textarea(取最后一个可见的);一级=第一个可见 textarea。
  say('点开输入框…');
  const taSel = await wvEval<string | null>(wv, `(() => {
    const tas=[...document.querySelectorAll('.comment-area textarea')].filter(t=>t.getBoundingClientRect().height>0);
    if (!tas.length) return null;
    const t=${spec.action === 'sub-reply' ? 'tas[tas.length-1]' : 'tas[0]'};
    return t.id ? ('[id="'+t.id+'"]') : '.comment-area textarea';
  })()`);
  if (!taSel) return { ok: false, detail: '评论输入框没出现(评论区可能没展开成功)' };
  if (!(await focusByClick(wv, taSel))) return { ok: false, detail: '评论输入框聚焦失败' };

  say('拟人输入回复…');
  await typeText(wv, spec.text.slice(0, 190), undefined, { slow: true }); // 百度知道评论上限 200 字
  await sleep(600);

  // 发送:【必须点与该输入框同一编辑器区块里的「发表」】——页面常同时开着多个编辑器
  // (顶部公共评论框也有一个「发表」),clickRealByText 全局找第一个会点错(实机踩过:回复
  // 文本留在框里没发出去)。定位【输入框最近的编辑器 scope 内】的按钮坐标,直接真实鼠标点击。
  say('发表…');
  // 按钮定位(2026-07-20 实机第三轮校准):楼中楼编辑器在 .reply-comment-area 里,真按钮是
  // <a.reply-comment-submit>(顶格评论框的是 .comment-action-wrap 里 .comment-action 的 <a>)。
  // 【不能按文本找 div】——同文案的容器 div(comment-action-bar / reply-comment-action-bar)
  // 会先命中,点它的中心=点在空处(实机踩过:文本留框里没发出)。优先精确 <a>,兜底取
  // 【离输入框最近的、无子元素的】文本「发表」叶子节点。
  const findSendPos = `(() => {
    const ta=document.querySelector(${JSON.stringify(taSel)});
    if (!ta) return null;
    const scope=ta.closest('.reply-comment-area') || ta.closest('.comment-action-wrap') || ta.closest('.comment-area');
    if (!scope) return null;
    let btn=scope.querySelector('a.reply-comment-submit')
      || scope.querySelector('.comment-action a')
      || [...scope.querySelectorAll('a')].find(e=>(e.textContent||'').trim()==='发表'&&e.getBoundingClientRect().width>0);
    if (!btn) {
      const tr=ta.getBoundingClientRect();
      const leaves=[...scope.querySelectorAll('span,div,button')].filter(e=>e.children.length===0&&(e.textContent||'').trim()==='发表'&&e.getBoundingClientRect().width>0);
      leaves.sort((p,q)=>Math.abs(p.getBoundingClientRect().top-tr.top)-Math.abs(q.getBoundingClientRect().top-tr.top));
      btn=leaves[0];
    }
    if (!btn) return null;
    btn.scrollIntoView({block:'center'});
    const r=btn.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
  })()`;
  await wvEval(wv, findSendPos); // 先滚到中心
  await sleep(500);
  const sent = await wvEval<{ x: number; y: number } | null>(wv, findSendPos); // 稳定后重取坐标
  if (!sent) return { ok: false, detail: '输入成功但没找到本编辑器的「发表」按钮' };
  wv.sendInputEvent({ type: 'mouseMove', x: sent.x, y: sent.y });
  await sleep(160);
  wv.sendInputEvent({ type: 'mouseDown', x: sent.x, y: sent.y, button: 'left', clickCount: 1 });
  await sleep(80);
  wv.sendInputEvent({ type: 'mouseUp', x: sent.x, y: sent.y, button: 'left', clickCount: 1 });
  await sleep(2000);
  // 提交验证:发表成功后百度会清空输入框(常整个收起)。输入框还留着我们的文本=没发出去。
  const leftover = await wvEval<boolean>(wv, `(() => { const ta=document.querySelector(${JSON.stringify(taSel)}); return Boolean(ta && ta.value && ta.value.length > 0); })()`);
  if (leftover) {
    // 补一击(处理器晚绑/首击落空),再验一次。
    wv.sendInputEvent({ type: 'mouseDown', x: sent.x, y: sent.y, button: 'left', clickCount: 1 });
    await sleep(80);
    wv.sendInputEvent({ type: 'mouseUp', x: sent.x, y: sent.y, button: 'left', clickCount: 1 });
    await sleep(2000);
    const still = await wvEval<boolean>(wv, `(() => { const ta=document.querySelector(${JSON.stringify(taSel)}); return Boolean(ta && ta.value && ta.value.length > 0); })()`);
    if (still) return { ok: false, detail: '点了「发表」但文本仍在输入框(未发出)——请在标签里手动点一下发表' };
  }
  return { ok: true, detail: `已回复:${spec.text.slice(0, 20)}${spec.text.length > 20 ? '…' : ''}` };
}

/**
 * 知乎评论回复(W9,2026-07-20 打包实例实机校准)。回答页评论默认收起:点「N 条评论」展开
 * (变「收起评论」)→ 评论条 div[data-id](真实评论 id)→ 楼中楼:点条内「回复」按钮弹出
 * DraftJS 编辑器(.public-DraftEditor-content,新弹的是【最后一个】)→ 拟人键入 → 点「发布」
 * (取离该编辑器最近的,页面常同时有顶部添加评论框)。一级评论:顶部「添加评论」框。
 */
async function injectZhihuReply(
  wv: DraftWebview,
  spec: ReplyInjectSpec,
  say: (m: string) => void,
): Promise<ReplyInjectResult> {
  const pageRef = spec.action === 'sub-reply' ? (spec.noteRef ?? '') : spec.targetRef;
  const url = buildNoteUrl('zhihu', pageRef);
  if (url) {
    say('打开回答页…');
    await wvEval(wv, `location.href = ${JSON.stringify(url)}`);
    await ready(wv);
    await sleep(2000);
  }
  const loggedOut = await wvEval<boolean>(
    wv,
    `(() => { const a=[...document.querySelectorAll('button,a')].find(x=>{const t=(x.textContent||'').trim(); const r=x.getBoundingClientRect(); return (t==='登录'||t==='登录/注册')&&r.width>0&&r.top<80;}); return Boolean(a); })()`,
  );
  if (loggedOut) return { ok: false, detail: '知乎未登录——在账号页登录知乎后重试' };

  // 展开评论(处理器可能晚绑:循环点到评论条真渲染,最多 5 轮)。
  say('展开评论区…');
  let expanded = false;
  for (let round = 0; round < 5 && !expanded; round++) {
    await wvEval(wv, `(() => { const b=[...document.querySelectorAll('button')].find(x=>/\\d+\\s*条评论/.test((x.textContent||'').trim())&&x.getBoundingClientRect().width>0); if(b){ b.scrollIntoView({block:'center'}); b.click(); } return true; })()`);
    await sleep(1800);
    expanded = Boolean(await wvEval<boolean>(wv, `Boolean([...document.querySelectorAll('div[data-id]')].find(d=>d.querySelector('.CommentContent')))`));
  }

  if (spec.action === 'sub-reply') {
    if (!expanded) return { ok: false, detail: '评论区没展开(「条评论」按钮点了没反应)——稍后重试' };
    say('定位目标评论,点开「回复」…');
    const opened = await wvEval<boolean>(wv, `(() => {
      const it=[...document.querySelectorAll('div[data-id]')].find(d=>d.getAttribute('data-id')===${JSON.stringify(spec.targetRef)});
      if (!it) return false;
      const btn=[...it.querySelectorAll('button')].find(b=>(b.textContent||'').trim().indexOf('回复')>=0);
      if (!btn) return false;
      it.scrollIntoView({block:'center'}); btn.click(); return true;
    })()`);
    if (!opened) return { ok: false, detail: '没找到目标评论的「回复」入口(评论可能翻页在后面或已删除)' };
    await sleep(1800);
  } else {
    // 一级评论:点「添加评论」唤起顶部评论框。
    await clickRealByText(wv, ['添加评论', '​添加评论', '写下你的评论']);
    await sleep(1200);
  }

  // 聚焦编辑器:楼中楼=最后一个可见 DraftJS 编辑器(新弹的);一级=第一个。
  say('点开输入框…');
  const edSel = await wvEval<string | null>(wv, `(() => {
    const eds=[...document.querySelectorAll('.public-DraftEditor-content')].filter(e=>e.getBoundingClientRect().height>0);
    if (!eds.length) return null;
    const t=${spec.action === 'sub-reply' ? 'eds[eds.length-1]' : 'eds[0]'};
    t.setAttribute('data-od-target','1');
    return '[data-od-target="1"]';
  })()`);
  if (!edSel) return { ok: false, detail: '评论输入框没出现(编辑器未唤起)' };
  if (!(await focusByClick(wv, edSel))) return { ok: false, detail: '评论输入框聚焦失败' };

  say('输入回复…');
  // 知乎评论=DraftJS(React 富文本):只认 beforeInput,typeText 的 per-char `char` 事件【不落字】
  // (2026-07-20 实机确认:发布按钮一直灰着)。改用 execCommand('insertText')——DraftJS 收到
  // 合成 beforeInput 正常落字、按钮转可用。typeText 兜底(极端情况)。
  const typed = await wvEval<boolean>(
    wv,
    `(() => { try { const ed=document.querySelector('[data-od-target="1"]'); if(ed&&ed.focus) ed.focus(); return document.execCommand('insertText', false, ${JSON.stringify(spec.text)}); } catch(e){ return false; } })()`,
  );
  if (!typed) await typeText(wv, spec.text, undefined, { slow: true });
  await sleep(800);

  // 发布:取【离目标编辑器最近的】可用「发布」按钮(顶部添加评论框也有一个,不能全局点第一个)。
  say('发布…');
  const pos = await wvEval<{ x: number; y: number } | null>(wv, `(() => {
    const ed=document.querySelector('[data-od-target="1"]');
    if (!ed) return null;
    const er=ed.getBoundingClientRect();
    const norm=(s)=>(s||'').replace(/[\\u200b-\\u200d\\ufeff]/g,'').trim();  // 知乎按钮文本常带零宽字符
    const btns=[...document.querySelectorAll('button')].filter(b=>norm(b.textContent)==='发布'&&!b.disabled&&b.getBoundingClientRect().width>0);
    if (!btns.length) return null;
    btns.sort((p,q)=>Math.abs(p.getBoundingClientRect().top-er.top)-Math.abs(q.getBoundingClientRect().top-er.top));
    const b=btns[0]; b.scrollIntoView({block:'center'});
    const r=b.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
  })()`);
  if (!pos) return { ok: false, detail: '输入成功但没找到可用的「发布」按钮' };
  wv.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
  await sleep(150);
  wv.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(80);
  wv.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(2000);
  // 提交验证:发布成功后编辑器清空/收起。
  const leftover = await wvEval<boolean>(wv, `(() => { const ed=document.querySelector('[data-od-target="1"]'); return Boolean(ed && (ed.innerText||'').trim().length>0); })()`);
  if (leftover) return { ok: false, detail: '点了「发布」但文本仍在输入框(未发出)——请在标签里手动点一下发布' };
  return { ok: true, detail: `已回复:${spec.text.slice(0, 20)}${spec.text.length > 20 ? '…' : ''}` };
}

/**
 * 微博评论回复(W10,2026-07-20 打包实例实机校准)。帖子详情页评论直接渲染(div.item1,
 * 文本「作者名:内容」)。v1 简化:楼中楼不去 hover 找逐条「回复」入口(悬浮才出现,易碎),
 * 而是按微博惯例在【主评论框】发「回复@作者:内容」——展示效果与原生回复一致。
 * 主评论框 textarea[placeholder*=评论],发送=框附近文本「评论/发送/发布」的可用按钮。
 */
async function injectWeiboReply(
  wv: DraftWebview,
  spec: ReplyInjectSpec,
  say: (m: string) => void,
): Promise<ReplyInjectResult> {
  const pageRef = spec.action === 'sub-reply' ? (spec.noteRef ?? '') : spec.targetRef;
  const url = buildNoteUrl('weibo', pageRef);
  if (url) {
    say('打开帖子页…');
    await wvEval(wv, `location.href = ${JSON.stringify(url)}`);
    await ready(wv);
    await sleep(2000);
  }
  if (await loginWalled(wv, 'weibo')) return { ok: false, detail: '微博未登录——在账号页登录微博后重试' };

  // 楼中楼:按合成 id 找到目标评论拿作者名,回复文案带「回复@作者:」前缀(微博惯例)。
  // 解析与 comment-extractors.weibo 完全同步(作者=首个 /u/ 链接或第1行;正文=冒号行)。
  let text = spec.text;
  if (spec.action === 'sub-reply') {
    const author = await wvEval<string | null>(wv, `(() => {
      const synthId=(a,t)=>'c_'+(a+'_'+t).replace(/\\s+/g,'').slice(0,24);
      for (const it of document.querySelectorAll('div.item1')) {
        if (it.parentElement && it.parentElement.closest('div.item1')) continue;
        const lines=(it.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
        if (lines.length<2) continue;
        const ua=[...it.querySelectorAll('a')].find(a=>/\\/u\\//.test(a.getAttribute('href')||'')&&(a.textContent||'').trim());
        const a=((ua&&ua.textContent)||lines[0]||'').trim().slice(0,40);
        const tl=lines.find(l=>/^[:：]/.test(l))||'';
        const t=tl.replace(/^[:：]\\s*/,'').trim().slice(0,500);
        if (a && t && synthId(a,t)===${JSON.stringify(spec.targetRef)}) { it.scrollIntoView({block:'center'}); return a; }
      }
      return null;
    })()`);
    if (!author) return { ok: false, detail: '没找到目标评论(可能翻页在后面或已删除)' };
    text = `回复@${author}:${spec.text}`;
  }

  say('点开评论框…');
  const TA = 'textarea[placeholder*="评论"], textarea';
  if (!(await focusByClick(wv, TA))) return { ok: false, detail: '评论输入框没找到(帖子页可能没加载完)' };

  say('拟人输入回复…');
  await typeText(wv, text.slice(0, 140), undefined, { slow: true }); // 微博评论上限 140 字
  await sleep(600);

  say('发送…');
  const pos = await wvEval<{ x: number; y: number } | null>(wv, `(() => {
    const ta=document.querySelector('textarea[placeholder*="评论"]') || document.querySelector('textarea');
    if (!ta) return null;
    // 从输入框向上走 5 层找同区块内可用的发送按钮(评论/发送/发布)。
    let scope=ta;
    for (let i=0;i<5&&scope;i++) {
      const btn=[...scope.querySelectorAll('button')].find(b=>{const t=(b.textContent||'').trim(); return (t==='评论'||t==='发送'||t==='发布')&&!b.disabled&&b.getBoundingClientRect().width>0;});
      if (btn) { btn.scrollIntoView({block:'center'}); const r=btn.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; }
      scope=scope.parentElement;
    }
    return null;
  })()`);
  if (!pos) return { ok: false, detail: '输入成功但没找到可用的发送按钮' };
  wv.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
  await sleep(150);
  wv.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(80);
  wv.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(2000);
  const leftover = await wvEval<boolean>(wv, `(() => { const ta=document.querySelector('textarea[placeholder*="评论"]') || document.querySelector('textarea'); return Boolean(ta && ta.value && ta.value.length>0); })()`);
  if (leftover) return { ok: false, detail: '点了发送但文本仍在输入框(未发出)——请在标签里手动点一下发送' };
  return { ok: true, detail: `已回复:${text.slice(0, 20)}${text.length > 20 ? '…' : ''}` };
}

const INJECTORS: Record<string, (wv: DraftWebview, spec: ReplyInjectSpec, say: (m: string) => void) => Promise<ReplyInjectResult>> = {
  xiaohongshu: injectXhsReply,
  'baidu-zhidao': injectBaiduReply,
  zhihu: injectZhihuReply,
  weibo: injectWeiboReply,
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
  if (!fn) return { ok: false, detail: `「${spec.platform}」的自动回复暂未接入(当前支持小红书/百度知道/知乎/微博)` };
  try {
    return await fn(wv, spec, say);
  } catch (err) {
    return { ok: false, detail: `回复注入异常:${err instanceof Error ? err.message : String(err)}` };
  }
}
