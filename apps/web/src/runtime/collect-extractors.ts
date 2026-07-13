// 内置浏览器采集：搜索页 URL 构造（排序/时间窗/翻页）+ 提取器 JS + 登录墙特征。
//
// 提取器在 webview 里 executeJavaScript 跑，返回统一扁平条目
// （content_id/title/url/likes/comments/plays/author/publish_time）。喂引擎 --collect-file。
// 时间窗优先在【搜索参数】里过滤（服务端更准），引擎侧再按 publish_time 兜底。
import type { StudioCollectPlatform } from '@open-design/contracts';

/** 时间窗 → 秒（'all' = 不限）。 */
export const WINDOW_SECONDS: Record<string, number> = {
  '1d': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
  '180d': 15_552_000,
  '365d': 31_536_000,
};

/** 无限滚动(true) vs 分页翻页(false)。B站是分页；小红书/抖音/快手是无限滚动。 */
export const INFINITE_SCROLL: Record<StudioCollectPlatform, boolean> = {
  xiaohongshu: true,
  douyin: true,
  bilibili: false,
  kuaishou: true,
};

export const LOGIN_WALL: Record<StudioCollectPlatform, string[]> = {
  xiaohongshu: ['登录后查看', '扫码登录', '手机号登录'],
  douyin: ['登录后可查看', '扫码登录', '验证码登录'],
  bilibili: [],
  kuaishou: ['扫码登录后', '请先登录'],
};

/** 需要「模拟人操作」在搜索框输入+回车才会真出结果的平台（直接跳URL不触发搜索/反爬）。
 *  快手就是这样：navigate到搜索页只落在空视图，得像人一样在框里搜。
 *  注意：抖音/小红书这类复杂 SPA 模拟打字极不可靠(打了字但不真跳搜索结果、抓成推荐流),
 *  故它们不走打字,改走「首页暖场→再进搜索页」(见 WARMUP_HOMEPAGE)兼顾拟人与可靠。 */
export const SEARCH_BY_TYPING: Record<StudioCollectPlatform, boolean> = {
  xiaohongshu: false,
  douyin: false,
  bilibili: false,
  kuaishou: true,
};

/** 「首页暖场」平台：进搜索页前先访问平台首页,建立会话/referrer、走出真人进站轨迹,
 *  再 navigate 到搜索结果 URL(referrer=首页)。比裸跳搜索 URL 更不易触发反爬/封号,
 *  又比模拟打字可靠(直连搜索页能拿到正确关键词结果)。抖音/小红书反爬凶,开启暖场。 */
export const WARMUP_HOMEPAGE: Partial<Record<StudioCollectPlatform, string>> = {
  douyin: 'https://www.douyin.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
};

/** 生成「在搜索框输入关键词并回车」的 JS（React 受控输入用原生 setter + input 事件）。 */
export function buildSearchSubmitJs(keyword: string): string {
  const kw = JSON.stringify(keyword);
  return `(() => {
    const kw = ${kw};
    const input = document.querySelector('input[placeholder*="搜索"], input[placeholder*="搜"], .search-input input, input.search-input, input[type="search"], header input, input');
    if (!input) return 'no-input';
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, kw); else input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    const btn = document.querySelector('.search-btn, [class*="search-button"], [class*="searchBtn"], button[type="submit"]');
    if (btn) btn.click();
    return 'submitted';
  })()`;
}

export interface SearchParams {
  /** 排序：hot=按热度/最多播放(默认，找爆款), latest=最新, comprehensive=综合。 */
  order?: 'hot' | 'latest' | 'comprehensive';
  /** 时间窗 key（见 WINDOW_SECONDS）；'all'/空 = 不限。 */
  timeWindow?: string;
  /** 分页页码（分页平台用；无限滚动平台忽略）。 */
  page?: number;
  /** 当前时间（秒），用于算时间窗起点；由调用方传入（脚本不可用 Date.now 时）。 */
  nowSec?: number;
}

const BILI_ORDER: Record<string, string> = { hot: 'click', latest: 'pubdate', comprehensive: 'totalrank' };

/** 构造某平台某页的搜索 URL（含排序/时间窗/翻页参数）。 */
export function buildSearchUrl(
  platform: StudioCollectPlatform,
  keyword: string,
  params: SearchParams = {},
): string {
  const kw = encodeURIComponent(keyword);
  const page = Math.max(1, params.page ?? 1);
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  const winSec = WINDOW_SECONDS[params.timeWindow ?? 'all'] ?? 0;
  if (platform === 'bilibili') {
    const order = BILI_ORDER[params.order ?? 'hot'] ?? 'click';
    let url = `https://search.bilibili.com/all?keyword=${kw}&order=${order}&page=${page}`;
    if (winSec > 0) url += `&pubtime_begin_s=${now - winSec}&pubtime_end_s=${now}`;
    return url;
  }
  if (platform === 'douyin') {
    // 抖音搜索：type=video；时间用 publish_time 档位(0全部/1一天/7一周/182半年/365一年)。
    const dyPublish = winSec === 0 ? 0 : winSec <= 86_400 ? 1 : winSec <= 604_800 ? 7 : winSec <= 15_552_000 ? 182 : 365;
    const sortType = params.order === 'latest' ? 2 : params.order === 'comprehensive' ? 0 : 1; // 1=最多点赞
    return `https://www.douyin.com/search/${kw}?type=video&publish_time=${dyPublish}&sort_type=${sortType}`;
  }
  if (platform === 'xiaohongshu') {
    const xhsSort = params.order === 'latest' ? 'time_descending' : params.order === 'comprehensive' ? 'general' : 'popularity_descending';
    return `https://www.xiaohongshu.com/search_result?keyword=${kw}&sort=${xhsSort}`;
  }
  // kuaishou
  return `https://www.kuaishou.com/search/video?searchKey=${kw}`;
}

/** 每平台提取器：IIFE 表达式（executeJavaScript 直接吃，返回数组）。
 *  日期解析：能解析成 YYYY-MM-DD 就给 publish_time(unix 秒)，否则 0。 */
export const EXTRACTORS: Record<StudioCollectPlatform, string> = {
  bilibili: `(() => {
    const YEAR = new Date().getFullYear();
    // B站日期两种：'· 2025-04-11'(YYYY-MM-DD) 或 '· 03-17'(当年 MM-DD)。取'·'后那段。
    const toTs = (txt) => {
      let m = (txt||'').match(/·\\s*(20\\d\\d)-(\\d{1,2})-(\\d{1,2})/);
      if (m) return Math.floor(new Date(+m[1], +m[2]-1, +m[3]).getTime()/1000);
      m = (txt||'').match(/·\\s*(\\d{1,2})-(\\d{1,2})(?!\\d)/);
      if (m) return Math.floor(new Date(YEAR, +m[1]-1, +m[2]).getTime()/1000);
      return 0;
    };
    const out = [], seen = new Set();
    document.querySelectorAll('.bili-video-card, a[href*="/video/BV"]').forEach(node => {
      const a = node.matches('a[href*="/video/BV"]') ? node : node.querySelector('a[href*="/video/BV"]');
      if (!a) return;
      const m = a.href.match(/\\/video\\/(BV[0-9a-zA-Z]+)/);
      if (!m) return;
      const id = m[1]; if (seen.has(id)) return;
      const card = a.closest('.bili-video-card') || node;
      const title = (card.querySelector('.bili-video-card__info--tit, h3, .title')?.innerText || a.getAttribute('title') || '').trim().slice(0, 90);
      if (!title) return;
      const stats = card.querySelectorAll('.bili-video-card__stats--item span, .bili-video-card__stats span');
      const author = (card.querySelector('.bili-video-card__info--author, .up-name')?.innerText || '').trim();
      seen.add(id);
      out.push({ content_id: id, title, url: 'https://www.bilibili.com/video/' + id,
        plays: (stats[0]?.innerText || '0').trim(), comments: (stats[1]?.innerText || '0').trim(),
        author, publish_time: toTs(card.innerText) });
    });
    return out;
  })()`,
  xiaohongshu: `(() => {
    const out = [], seen = new Set();
    document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]').forEach(a => {
      const m = a.href.match(/\\/(explore|search_result|item)\\/([0-9a-zA-Z]+)/);
      if (!m) return;
      const id = m[2]; if (seen.has(id)) return;
      const card = a.closest('section, .note-item') || a.parentElement?.parentElement || a;
      const title = (card.querySelector('.title, .footer .title, .content, span')?.innerText || a.innerText || '').trim().slice(0, 90);
      const likeEl = card.querySelector('.like-wrapper .count, .count, .like-count');
      const author = (card.querySelector('.author .name, .name, .user-name')?.innerText || '').trim();
      if (!title) return;
      seen.add(id);
      out.push({ content_id: id, title, url: 'https://www.xiaohongshu.com/explore/' + id, likes: (likeEl?.innerText || '0').trim(), author });
    });
    return out;
  })()`,
  douyin: `(() => {
    // 抖音类名混淆，按卡片文本解析：[合集|]时长|点赞|标题#标签@提及|@作者|日期(2天前/4周前)。
    const YEAR = new Date().getFullYear();
    const parseRel = (s) => {
      s = (s||'').trim();
      let m = s.match(/(20\\d\\d)-(\\d{1,2})-(\\d{1,2})/);
      if (m) return Math.floor(new Date(+m[1],+m[2]-1,+m[3]).getTime()/1000);
      m = s.match(/(\\d{1,2})-(\\d{1,2})$/);
      if (m) return Math.floor(new Date(YEAR,+m[1]-1,+m[2]).getTime()/1000);
      const now = Math.floor(Date.now()/1000);
      if (/昨天/.test(s)) return now - 86400;
      if (/(小时|分钟|刚刚|今天)/.test(s)) return now;
      m = s.match(/(\\d+)\\s*天前/); if (m) return now - (+m[1])*86400;
      m = s.match(/(\\d+)\\s*周前/); if (m) return now - (+m[1])*604800;
      m = s.match(/(\\d+)\\s*(个)?月前/); if (m) return now - (+m[1])*2592000;
      m = s.match(/(\\d+)\\s*年前/); if (m) return now - (+m[1])*31536000;
      return 0;
    };
    const out = [], seen = new Set();
    document.querySelectorAll('.search-result-card, li[data-e2e]').forEach(card => {
      const a = card.querySelector('a[href*="/video/"]');
      if (!a) return;
      const m = a.href.match(/\\/video\\/(\\d+)/);
      if (!m) return;
      const id = m[1]; if (seen.has(id)) return;
      const lines = card.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
      let date = '', author = '', likes = '0';
      for (const ln of lines) {
        if (!date && (/前$/.test(ln) || /^\\d{4}-\\d{1,2}-\\d{1,2}/.test(ln) || /昨天|今天/.test(ln))) date = ln;
        else if (!author && ln.startsWith('@')) author = ln.replace(/^@/, '');
        else if (likes === '0' && /^[\\d.]+\\s*[万wW亿]?$/.test(ln)) likes = ln;
      }
      const cand = lines.filter(ln => ln !== date && ('@'+author) !== ln && ln !== likes
        && !/^\\d{1,2}:\\d{2}/.test(ln) && ln !== '合集' && !/^[\\d.]+\\s*[万wW亿]?$/.test(ln));
      let title = (cand.sort((a, b) => b.length - a.length)[0] || '');
      title = title.replace(/#[^\\s#]+/g, '').replace(/@[^\\s@]+/g, '').trim().slice(0, 90);
      if (!title) return;
      seen.add(id);
      out.push({ content_id: id, title, url: 'https://www.douyin.com/video/' + id,
        likes, author, publish_time: parseRel(date) });
    });
    return out;
  })()`,
  kuaishou: `(() => {
    // 快手搜索结果是 div 卡片(无 <a>)：.card-container > .photo-card[data-like-count="⭐ N"]，
    // 标题在 .caption(或 img.alt)，作者在文本行，点赞在 data-like-count 属性。
    const out = [], seen = new Set();
    document.querySelectorAll('.card-container').forEach(card => {
      const pc = card.querySelector('.photo-card') || card;
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      let title = (card.querySelector('.caption, .cover-img')?.innerText
        || card.querySelector('img')?.getAttribute('alt') || lines[0] || '').replace(/#[^\\s#]+/g, '').trim().slice(0, 90);
      if (!title) return;
      const likeRaw = pc.getAttribute('data-like-count') || lines.find(ln => /^[\\d.]+\\s*[万wW]?$/.test(ln)) || '0';
      const likes = (String(likeRaw).match(/[\\d.]+\\s*[万wW]?/) || ['0'])[0];
      const author = (lines.find(ln => ln !== lines[0] && !/^[\\d.]+\\s*[万wW]?$/.test(ln) && !ln.includes('#')) || '').slice(0, 30);
      const id = 'ks_' + title.replace(/[^\\w一-龥]/g, '').slice(0, 20) + likes;
      if (seen.has(id)) return; seen.add(id);
      out.push({ content_id: id, title, likes, author, url: '' });
    });
    return out;
  })()`,
};
