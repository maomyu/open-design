// 评论树提取器 —— 在内置浏览器 webview 里 executeJavaScript 跑，读一条笔记/帖子的
// 评论 + 楼中楼，返回结构化 CommentNode[]。互动执行器（自动评论回复 W4/关键词匹配 W5）的输入。
//
// 与 collect-extractors 的搜索卡片抓取不同：这里抓的是【评论树】（一级评论 + 其楼中楼子回复）。
// 提取器是 IIFE 字符串，webview 内跑、返回 JSON；纯 helper（parseCount/buildNoteUrl）在这里
// 单测。选择器对真实页面易漂移，改版时优先只调 EXTRACTORS 里的 querySelector，不动外层运行时。
import type { CommentNode } from '@open-design/contracts';

export type CommentPlatform = 'xiaohongshu' | 'baidu-zhidao';

/** 评论页登录墙特征文案（命中则判未登录，交由上层引导扫码补登）。 */
export const COMMENT_LOGIN_WALL: Record<CommentPlatform, string[]> = {
  xiaohongshu: ['登录后查看', '扫码登录', '手机号登录', '登录后可查看更多'],
  // 百度知道问题页公开可读(读评论不吃登录墙);发评论才要登录,由注入器自判。
  'baidu-zhidao': [],
};

/**
 * 把中文点赞/数字文案解析成整数。'1.2万'→12000、'3.4w'→34000、'1亿'→1e8、
 * '99+'→99、'赞'/''/'点赞'→0、'1,234'→1234。纯函数，可单测。
 */
export function parseCount(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([万wW亿]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10_000);
  if (unit === '亿') return Math.round(n * 100_000_000);
  return Math.round(n);
}

/**
 * 从目标引用构造笔记/帖子 URL。ref 已是 http(s) 链接则原样返回；否则按平台当作 note id 拼。
 * 小红书笔记页：https://www.xiaohongshu.com/explore/<id>。
 */
export function buildNoteUrl(platform: CommentPlatform, ref: string): string {
  const r = String(ref ?? '').trim();
  if (/^https?:\/\//i.test(r)) return r;
  if (!r) return '';
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${encodeURIComponent(r)}`;
  if (platform === 'baidu-zhidao') return `https://zhidao.baidu.com/question/${encodeURIComponent(r)}.html`;
  return r;
}

// parseCount 的 JS 版内联进提取器（webview 里没有本模块，需自带一份同义实现）。
const PARSE_COUNT_JS = `(raw) => {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 0;
  const m = s.match(/([\\d.]+)\\s*([万wW亿]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return 0;
  if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') return Math.round(n * 10000);
  if (m[2] === '亿') return Math.round(n * 100000000);
  return Math.round(n);
}`;

/**
 * 每平台评论树提取器（IIFE 表达式，executeJavaScript 直接吃，返回 CommentNode[]）。
 *
 * 小红书笔记页评论区结构（2026-07，真机核对）：评论列表容器 .comments-container / .comment-list，
 * 每条一级评论 .parent-comment（内含 .comment-item），楼中楼在 .reply-container 里的 .comment-item。
 * 作者 .author（.name）、正文 .content .note-text、点赞 .like .count。选择器给多个候选兜底改版。
 */
export const COMMENT_EXTRACTORS: Record<CommentPlatform, string> = {
  xiaohongshu: `(() => {
    const parseCount = ${PARSE_COUNT_JS};
    const txt = (el, sels) => {
      for (const s of sels) { const n = el.querySelector(s); if (n && n.innerText != null && n.innerText.trim()) return n.innerText.trim(); }
      return '';
    };
    const synthId = (author, text) => 'c_' + (author + '_' + text).replace(/\\s+/g, '').slice(0, 24);
    const readItem = (el) => {
      const author = txt(el, ['.author .name', '.name', '.user-name', 'a.name']);
      const text = txt(el, ['.content .note-text', '.note-text', '.content', '.comment-text']).slice(0, 500);
      if (!author && !text) return null;
      const likeRaw = txt(el, ['.like .count', '.like-wrapper .count', '.count', '.like-count']);
      const time = txt(el, ['.date', '.time', '.info .date']).slice(0, 30);
      const idAttr = el.getAttribute('data-comment-id') || el.getAttribute('id') || '';
      const authorLink = el.querySelector('a.name, .author a, a[href*="/user/profile/"]');
      const am = authorLink ? (authorLink.getAttribute('href') || '').match(/\\/user\\/profile\\/([0-9a-zA-Z]+)/) : null;
      return {
        id: idAttr || synthId(author, text),
        author, text, likes: parseCount(likeRaw),
        ...(time ? { time } : {}),
        ...(am ? { authorId: am[1] } : {}),
        subReplies: [],
      };
    };
    const out = [];
    const seen = new Set();
    // 一级评论用 .parent-comment（真机核对：楼中楼在其内的 .reply-container 里，不会被这层选中）。
    // 老版本无 .parent-comment 时退回 .comments-container 直属 .comment-item（避免把楼中楼当一级）。
    let parents = document.querySelectorAll('.parent-comment');
    if (!parents.length) parents = document.querySelectorAll('.comments-container > .comment-item, .list-container > .comment-item');
    parents.forEach((p) => {
      // 一级评论本体：优先取 .parent-comment 内的首个 .comment-item，否则 p 自身。
      const head = p.matches('.comment-item') ? p : (p.querySelector(':scope > .comment-item') || p);
      const node = readItem(head);
      if (!node) return;
      if (seen.has(node.id)) return; seen.add(node.id);
      // 楼中楼：.reply-container / .sub-comment 下的每个 .comment-item。
      const subs = p.querySelectorAll('.reply-container .comment-item, .sub-comment .comment-item, .sub-comments .comment-item');
      subs.forEach((s) => { const sn = readItem(s); if (sn) node.subReplies.push(sn); });
      out.push(node);
    });
    return out;
  })()`,
  // 百度知道问题页(2026-07-20 真机校准):评论挂在【每条回答】下,默认折叠——须先点各回答
  // 页脚的「评论(N)」(span.comment)展开,评论区才渲染。展开后结构:
  //   .comment-area(每回答一个,无评论时带 .no-comment)
  //     └ .comment-body .comment-entry .comment-item
  //         ├ .details          作者 + 日期("ghnjik  2025-11-11 14:28")
  //         ├ .comment-content  正文
  //         └ .operation-con    赞/回复/举报
  // 无 data-id → 合成 id(作者+正文,与回复注入器同公式,两侧才能对上)。异步 IIFE:
  // executeJavaScript 会等 Promise,预算内(约 5s)只展开【带评论数】的按钮再读。
  'baidu-zhidao': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const synthId = (author, text) => 'c_' + (author + '_' + text).replace(/\\s+/g, '').slice(0, 24);
    // ① 展开有评论的回答(「评论(N)」才点;纯「评论」=0 条,点了也是空)。
    // 上层 evalJs 超时 6s:最多展开 4 个(4×800ms+1200ms≈4.4s),留读取余量。
    const btns = [...document.querySelectorAll('span.comment')].filter((b) => /评论\\s*\\(\\d+\\)/.test((b.textContent || '').trim()) && b.getBoundingClientRect().width > 0);
    for (const b of btns.slice(0, 4)) {
      try { b.scrollIntoView({ block: 'center' }); b.click(); } catch (e) {}
      await sleep(800);
    }
    await sleep(1200);
    // ② 读所有已展开评论区的评论条。
    const out = [], seen = new Set();
    document.querySelectorAll('.comment-area .comment-item').forEach((it) => {
      const details = (it.querySelector('.details') && it.querySelector('.details').innerText || '').trim();
      const text = (it.querySelector('.comment-content') && it.querySelector('.comment-content').innerText || '').trim().slice(0, 500);
      if (!text) return;
      // .details = "作者名   2025-11-11 14:28" —— 日期起始处切开。
      const dm = details.match(/(\\d{4}-\\d{2}-\\d{2}[^]*)$/);
      const time = dm ? dm[1].trim().slice(0, 30) : '';
      const author = (dm ? details.slice(0, dm.index) : details).trim().slice(0, 40);
      const id = synthId(author, text);
      if (seen.has(id)) return; seen.add(id);
      out.push({ id, author, text, likes: 0, ...(time ? { time } : {}), subReplies: [] });
    });
    return out;
  })()`,
};

export type { CommentNode };
