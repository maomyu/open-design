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
  // 大整数 id 防精度损坏:知乎新版问题 id ~2e18、抖音 aweme_id ~7e18,都超过 Number.MAX_SAFE_INTEGER
  // (9e15)——resp.json() 一解析就四舍五入成【另一个 id】,拼出的链接 404(2026-07-25 知乎直发真机事故:
  // /question/2062518030224061700 不存在,真 id 已不可考)。解析前把 ≥16 位的纯数字 *id* 字段值加引号
  // 转成字符串,后续取用原样保真。只动键名含 id 的字段,不影响播放量/时间戳等数值语义。
  const raw = await resp.text().catch(() => '{}');
  const safe = raw.replace(/"(\w*[iI]d)"\s*:\s*(\d{16,})(\s*[,}\]])/g, '"$1":"$2"$3');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(safe) as Record<string, unknown>;
  } catch {
    data = {};
  }
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

/**
 * 取平台内容 id 当字符串。大整数 id(知乎新版问题/回答 ~2e18 超 Number.MAX_SAFE_INTEGER)已在
 * tikhubFetch 层转成字符串防精度损坏,小 id 仍是数字——两种都要能取到,且【绝不再 Number() 一遍】。
 */
function idStr(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
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
      // id 已在 tikhubFetch 层转成字符串(大整数防精度损坏),原样取用;绝不再 Number() 一遍。
      const qid = idStr(target.id);
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

/**
 * 知乎搜索命中 → 能真正打开的网页链接。
 *
 * 搜索返回的 `object.url` 是接口内部地址(`api.zhihu.com/answers/{id}`),浏览器打不开;而 `id`
 * 对【回答】来说是回答 id——旧代码一律拼成 `zhuanlan.zhihu.com/p/{id}`(专栏文章地址),回答拼出来
 * 必 404(「你似乎来到了没有知识存在的荒原」)。按 type 分流:回答 → `/question/{qid}/answer/{aid}`
 * (问题 id 缺失就退 `/answer/{aid}`,知乎会自己跳),文章 → `zhuanlan.zhihu.com/p/{id}`。
 *
 * 回答页链接还是【互动区读评论】的前提:知乎评论接口按 answer_id 取,只有问题链接读不到评论。
 */
export function zhihuContentUrl(obj: Record<string, unknown>, title: string): string {
  const kind = pick(obj, ['type']);
  const id = idStr(obj.id);
  if (id && kind === 'answer') {
    const qid = idStr((obj.question as Record<string, unknown> | undefined)?.id);
    return qid
      ? `https://www.zhihu.com/question/${qid}/answer/${id}`
      : `https://www.zhihu.com/answer/${id}`;
  }
  if (id && (kind === 'article' || kind === '')) return `https://zhuanlan.zhihu.com/p/${id}`;
  return `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(title)}`;
}

async function zhihuSearch(key: string, keyword: string): Promise<MediaTopicHit[]> {
  const data = await tikhubFetch(
    key,
    `/api/v1/zhihu/web/fetch_article_search_v3?keyword=${encodeURIComponent(keyword)}&limit=20`,
  );
  // 真实响应(2026-07-25 实测):data.data 是 {type, object} 包装列表,object.type 区分
  // answer/article/people/ring_box/relevant_query——只有回答和文章能当选题,人和相关搜索没 title,
  // 由下面的 title 判空滤掉。
  const nested = ((data as Record<string, unknown>).data as Record<string, unknown> | undefined)?.data;
  const rows = Array.isArray(nested)
    ? (nested as Array<Record<string, unknown>>).filter((x) => typeof x === 'object' && x != null)
    : findObjectArray(data, ['title', 'excerpt']);
  return rows
    .map((r) => {
      const obj = (r.object ?? r) as Record<string, unknown>;
      const title = pick(obj, ['title']) || pick(r, ['title']);
      if (!title) return null;
      const author = (obj.author ?? {}) as Record<string, unknown>;
      const voteup = num(obj.voteup_count) ?? num(r.voteup_count);
      return hitOf(stripEm(title), zhihuContentUrl(obj, stripEm(title)), {
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
  // 真实响应(2026-07-25 实测):data.data.cards[] 是卡片列表,帖子在 card.mblog(card_type 9),
  // 字段是 {bid(base62), mid, text(HTML), user:{id, screen_name}}——【没有 mblogid、没有 text_raw】。
  // 旧代码找的正是这两个不存在的字段,于是每条都退化成 s.weibo.com 搜索页链接:互动区因此永远
  // 拿不到真帖子(只能手动往池里存),读评论更无从谈起。
  const cards = ((((data as Record<string, unknown>).data as Record<string, unknown> | undefined)
    ?.data as Record<string, unknown> | undefined)?.cards);
  const rows = Array.isArray(cards)
    ? (cards as Array<Record<string, unknown>>)
      .map((c) => (typeof c?.mblog === 'object' && c.mblog != null ? (c.mblog as Record<string, unknown>) : c))
      .filter((x) => typeof x === 'object' && x != null)
    : findObjectArray(data, ['text_raw', 'text', 'title']);
  return rows
    .map((r) => {
      const rawText = pick(r, ['text_raw', 'text', 'title']);
      if (!rawText) return null;
      const title = stripEm(rawText).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title) return null;
      const user = (r.user ?? {}) as Record<string, unknown>;
      const reposts = num(r.reposts_count);
      // 帖子页地址是 weibo.com/{uid}/{bid62}——bid 是 base62 短码,不是 mid;拿 mid 拼这个位置打不开。
      // uid 缺失时退 weibo.com/detail/{mid}(数字 mid 的规范形态,同样能开、也能读评论)。
      const bid = idStr(r.bid) || idStr(r.mblogid);
      const mid = idStr(r.mid) || idStr(r.id);
      const uid = idStr(user.idstr) || idStr(user.id);
      const url = bid && uid
        ? `https://weibo.com/${uid}/${bid}`
        : mid
          ? `https://weibo.com/detail/${mid}`
          : `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`;
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
