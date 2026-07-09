// TikHub（api.tikhub.io）选题数据直调 —— 短视频/图文的平台原生选题源
// (2026-07-09 用户拍板:短视频选题弃用极致数据,按目标平台分流——抖音选题
// 走抖音接口、小红书走小红书、快手走快手)。
//
// 端点按 OpenAPI(1009 路径)实测筛选,认证 `Authorization: Bearer <key>`:
//   抖音   热榜 GET  /api/v1/douyin/app/v3/fetch_hot_search_list
//          搜索 POST /api/v1/douyin/search/fetch_video_search_v1 {keyword}
//   小红书 热榜 GET  /api/v1/xiaohongshu/web_v3/fetch_hot_list
//          搜索 GET  /api/v1/xiaohongshu/app_v2/search_notes?keyword=
//   快手   热榜 GET  /api/v1/kuaishou/web/fetch_kuaishou_hot_list_v1
//          搜索 GET  /api/v1/kuaishou/app/search_comprehensive?keyword=
//
// 响应包裹为 {code, data: ...},内层结构各端点不同——解析走「候选字段防御
// 式」:递归找含标题字段的对象数组,字段名按优先序尝试。拿到真实 key 实测
// 后如有字段偏差,只需要调 adapter 的候选序。
import type { MediaTopicHit } from '@open-design/contracts';

const BASE = 'https://api.tikhub.io';

export class TikhubError extends Error {}

export type TikhubTarget = 'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo';
export type TikhubMode = 'hot' | 'search';

async function tikhubFetch(key: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const resp = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status === 401 || resp.status === 403) {
    throw new TikhubError('TikHub API Key 无效或没权限——去「设置 → 媒体生成 → TikHub」检查');
  }
  if (!resp.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data).slice(0, 160);
    throw new TikhubError(`TikHub 接口错误(${resp.status}): ${detail}`);
  }
  return data;
}

/** 递归找第一个「对象数组且元素含任一候选标题字段」的数组(深度≤5)。 */
function findObjectArray(payload: unknown, titleKeys: string[], depth = 0): Array<Record<string, unknown>> {
  if (depth > 5 || payload == null) return [];
  if (Array.isArray(payload)) {
    const objs = payload.filter((x): x is Record<string, unknown> => typeof x === 'object' && x != null);
    if (objs.length > 0 && objs.some((o) => titleKeys.some((k) => typeof o[k] === 'string' && (o[k] as string).trim()))) {
      return objs;
    }
    for (const item of payload) {
      const inner = findObjectArray(item, titleKeys, depth + 1);
      if (inner.length > 0) return inner;
    }
    return [];
  }
  if (typeof payload === 'object') {
    for (const value of Object.values(payload as Record<string, unknown>)) {
      const inner = findObjectArray(value, titleKeys, depth + 1);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return '';
}

function hitOf(title: string, url: string, extra: { account?: string; hot?: string | null; desc?: string | null }): MediaTopicHit {
  return {
    title,
    url,
    account: extra.account ?? '',
    publishedAt: '',
    signals: ['trending'],
    readNum: null,
    zanNum: null,
    hot: extra.hot ?? null,
    desc: extra.desc ?? null,
  };
}

// ---- 抖音 ----

async function douyinHot(key: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/douyin/app/v3/fetch_hot_search_list');
  // 真实响应(2026-07-09 实测):data.data.trending_list(5 条顶部看点,
  // hot_value=0)排在 word_list(51 条主榜,真热度)之前——显式取主榜,
  // 结构变化时再退回递归查找。
  const nested = ((data as Record<string, unknown>).data as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const wordList = Array.isArray(nested?.word_list)
    ? (nested.word_list as Array<Record<string, unknown>>).filter((x) => typeof x === 'object' && x != null)
    : [];
  const rows = wordList.length > 0 ? wordList : findObjectArray(data, ['word', 'sentence', 'title']);
  return rows
    .map((r) => {
      const title = pick(r, ['word', 'sentence', 'title']);
      if (!title) return null;
      const hotVal = num(r.hot_value) ?? num(r.heat) ?? num(r.hot_score);
      return hitOf(title, `https://www.douyin.com/search/${encodeURIComponent(title)}`, {
        hot: hotVal != null ? String(hotVal) : null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

async function douyinSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/douyin/search/fetch_video_search_v1', {
    method: 'POST',
    body: { keyword, cursor: 0, sort_type: '_0', publish_time: '_0', filter_duration: '_0', content_type: '_0', search_id: '' },
  });
  const rows = findObjectArray(data, ['desc', 'title', 'caption']);
  return rows
    .map((r) => {
      // 视频结果:desc=标题;aweme_id 拼视频链接;author.nickname=账号。
      const title = pick(r, ['desc', 'title', 'caption']);
      const awemeId = pick(r, ['aweme_id', 'awemeId', 'id']);
      if (!title || !awemeId) return null;
      const author = (r.author ?? {}) as Record<string, unknown>;
      const stats = (r.statistics ?? {}) as Record<string, unknown>;
      const digg = num(stats.digg_count);
      const hit = hitOf(title, `https://www.douyin.com/video/${awemeId}`, {
        account: pick(author, ['nickname', 'unique_id']),
        hot: digg != null ? `赞 ${digg}` : null,
      });
      return hit;
    })
    .filter((h): h is MediaTopicHit => h != null);
}

// ---- 小红书 ----

async function xhsHot(key: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/xiaohongshu/web_v3/fetch_hot_list');
  const rows = findObjectArray(data, ['title', 'word', 'name']);
  return rows
    .map((r) => {
      const title = pick(r, ['title', 'word', 'name']);
      if (!title) return null;
      const score = pick(r, ['score', 'hot_score']) || (num(r.score) != null ? String(num(r.score)) : '');
      return hitOf(title, `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`, {
        hot: score || null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

async function xhsSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(
    key,
    `/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(keyword)}&page=1&sort_type=general`,
  );
  const rows = findObjectArray(data, ['display_title', 'title', 'desc']);
  return rows
    .map((r) => {
      const title = pick(r, ['display_title', 'title', 'desc']);
      const id = pick(r, ['note_id', 'id']);
      if (!title) return null;
      const user = (r.user ?? {}) as Record<string, unknown>;
      const liked = num(r.liked_count) ?? num((r.interact_info as Record<string, unknown> | undefined)?.liked_count);
      return hitOf(title, id ? `https://www.xiaohongshu.com/explore/${id}` : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`, {
        account: pick(user, ['nickname', 'nick_name', 'name']),
        hot: liked != null ? `赞 ${liked}` : null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

// ---- 快手 ----

async function ksHot(key: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/kuaishou/web/fetch_kuaishou_hot_list_v1');
  const rows = findObjectArray(data, ['name', 'word', 'title']);
  return rows
    .map((r) => {
      const title = pick(r, ['name', 'word', 'title']);
      if (!title) return null;
      const hotVal = pick(r, ['hotValue', 'hot_value']) || (num(r.hotValue) != null ? String(num(r.hotValue)) : '');
      return hitOf(title, `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(title)}`, {
        hot: hotVal || null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

async function ksSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(
    key,
    `/api/v1/kuaishou/app/search_comprehensive?keyword=${encodeURIComponent(keyword)}`,
  );
  const rows = findObjectArray(data, ['caption', 'title', 'desc']);
  return rows
    .map((r) => {
      const title = pick(r, ['caption', 'title', 'desc']);
      const id = pick(r, ['photo_id', 'photoId', 'id']);
      if (!title) return null;
      const user = (r.user ?? r.author ?? {}) as Record<string, unknown>;
      return hitOf(title, id ? `https://www.kuaishou.com/short-video/${id}` : `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(title)}`, {
        account: pick(user, ['user_name', 'nickname', 'name']),
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

// ---- 知乎 ----

async function zhihuHot(key: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/zhihu/web/fetch_hot_list?limit=50');
  // 真实响应(2026-07-10 实测):主榜在 data.data(30 条,item.target 是问题
  // 实体:title/id/answer_count;detail_text=「1288 万热度」);头部公益卡在
  // head_zone,别让它抢先命中。
  const nested = ((data as Record<string, unknown>).data as Record<string, unknown> | undefined)?.data;
  const rows = Array.isArray(nested)
    ? (nested as Array<Record<string, unknown>>).filter((x) => typeof x === 'object' && x != null)
    : findObjectArray(data, ['title']);
  return rows
    .map((r) => {
      const target = (r.target ?? {}) as Record<string, unknown>;
      const title = pick(target, ['title']) || pick(r, ['title', 'word']);
      if (!title) return null;
      const hot = pick(r, ['detail_text', 'hot_text']);
      const answers = num(target.answer_count);
      const qid = num(target.id) != null ? String(num(target.id)) : pick(target, ['id']);
      const url = qid
        ? `https://www.zhihu.com/question/${qid}`
        : `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(title)}`;
      return hitOf(title, url, {
        hot: hot || (answers != null ? `${answers} 回答` : null),
        desc: answers != null ? `${answers} 回答` : null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

async function zhihuSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(
    key,
    `/api/v1/zhihu/web/fetch_article_search_v3?keyword=${encodeURIComponent(keyword)}&limit=20`,
  );
  const rows = findObjectArray(data, ['title', 'excerpt']);
  return rows
    .map((r) => {
      const obj = (r.object ?? r) as Record<string, unknown>;
      const title = pick(obj, ['title']) || pick(r, ['title']);
      if (!title) return null;
      const author = (obj.author ?? {}) as Record<string, unknown>;
      const voteup = num(obj.voteup_count) ?? num(r.voteup_count);
      const id = pick(obj, ['id']) || pick(r, ['id']);
      const url = id ? `https://zhuanlan.zhihu.com/p/${id}` : `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(title)}`;
      return hitOf(stripEm(title), url, {
        account: pick(author, ['name', 'nickname']),
        hot: voteup != null ? `赞 ${voteup}` : null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

// ---- 微博 ----

async function weiboHot(key: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(key, '/api/v1/weibo/web_v2/fetch_hot_search_summary');
  // 真实响应(2026-07-10 实测):data.data 51 条 {rank, keyword, keyword_url,
  // heat, tag}。
  const nested = ((data as Record<string, unknown>).data as Record<string, unknown> | undefined)?.data;
  const rows = Array.isArray(nested)
    ? (nested as Array<Record<string, unknown>>).filter((x) => typeof x === 'object' && x != null)
    : findObjectArray(data, ['keyword', 'word']);
  return rows
    .map((r) => {
      const title = pick(r, ['keyword', 'word', 'note', 'title']);
      if (!title) return null;
      const heat = num(r.heat);
      const url = pick(r, ['keyword_url']) || `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${title}#`)}`;
      return hitOf(title, url, {
        hot: heat != null ? String(heat) : pick(r, ['tag']) || null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

async function weiboSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(
    key,
    `/api/v1/weibo/web/fetch_search?keyword=${encodeURIComponent(keyword)}&page=1`,
  );
  const rows = findObjectArray(data, ['text_raw', 'text', 'title']);
  return rows
    .map((r) => {
      const rawText = pick(r, ['text_raw', 'text', 'title']);
      if (!rawText) return null;
      const title = stripEm(rawText).replace(/\s+/g, ' ').slice(0, 60);
      const user = (r.user ?? {}) as Record<string, unknown>;
      const reposts = num(r.reposts_count);
      const mid = pick(r, ['mblogid', 'mid', 'id']);
      const uid = pick(user, ['idstr', 'id']) || (num(user.id) != null ? String(num(user.id)) : '');
      const url = mid && uid ? `https://weibo.com/${uid}/${mid}` : `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`;
      return hitOf(title, url, {
        account: pick(user, ['screen_name', 'name']),
        hot: reposts != null ? `转 ${reposts}` : null,
      });
    })
    .filter((h): h is MediaTopicHit => h != null);
}

/** 去掉搜索结果标题里的高亮标记(<em>)。 */
function stripEm(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** 平台分流入口:target 平台 × hot/search 模式 → 统一选题命中。 */
export async function tikhubTopicFeed(
  key: string,
  target: TikhubTarget,
  mode: TikhubMode,
  keyword?: string,
): Promise<MediaTopicHit[]> {
  if (mode === 'search' && !keyword?.trim()) {
    throw new TikhubError('关键词搜索需要 keyword');
  }
  const kw = keyword?.trim() ?? '';
  if (target === 'douyin') return mode === 'hot' ? douyinHot(key) : douyinSearch(key, kw);
  if (target === 'xiaohongshu') return mode === 'hot' ? xhsHot(key) : xhsSearch(key, kw);
  if (target === 'kuaishou') return mode === 'hot' ? ksHot(key) : ksSearch(key, kw);
  if (target === 'zhihu') return mode === 'hot' ? zhihuHot(key) : zhihuSearch(key, kw);
  if (target === 'weibo') return mode === 'hot' ? weiboHot(key) : weiboSearch(key, kw);
  throw new TikhubError(`不支持的平台: ${String(target)}`);
}
