/**
 * Dajiala（大家来）data feeds — TS port of the workbench scripts
 * `dajiala_hot_search.py` / `dajiala_realtime_search.py` / `topic_radar.py`
 * so the studio's 选题 buttons are deterministic product calls (fast, no
 * agent tokens). The Python originals stay for the plugin pipeline.
 *
 * API contracts (mirrored from the scripts):
 *  - hot_typical_search: multipart form {key, keyword, pub_type, category,
 *    page, start_time, end_time} → {code, data|list:[{title,url,read_num,
 *    zan_num,hot,mp_nickname,pub_time,...}]}
 *  - web_search: JSON {mode:2, keyword, BusinessType:2, Sub_search_type,
 *    currentPage, offset, cookies_buffer, key, verifycode} →
 *    {code, data:[{items:[{title,doc_url,desc,source:{title,dateTime},...}]}]}
 *  - radar merge: key by wechat url mid/idx/sn else normalized title;
 *    ⭐ both / 🔥 trending-only / 🔍 realtime-only.
 *
 * Costs are charged by dajiala per call/item; per the plugin's standing rule
 * (用户可见输出永远不带价格) the UI surfaces counts only — keep prices out of
 * responses.
 */
import type { MediaTopicHit } from '@open-design/contracts';

const HOT_URL = 'https://www.dajiala.com/fbmain/monitor/v3/hot_typical_search';
const WEB_URL = 'https://www.dajiala.com/fbmain/monitor/v3/web_search';
const RETRY_BACKOFF_MS = [1000, 3000, 6000];
const TIMEOUT_MS = 30_000;

const SORT_MAP: Record<string, number> = { all: 0, latest: 2, hottest: 4 };

export class DajialaError extends Error {}

async function postWithRetry(url: string, init: () => RequestInit): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const resp = await fetch(url, { ...init(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!resp.ok) throw new DajialaError(`大家来接口 HTTP ${resp.status}`);
      return (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
      if (err instanceof DajialaError) throw err;
      if (attempt < RETRY_BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new DajialaError(String(lastErr));
}

function requireOk(data: Record<string, unknown>, feed: string): void {
  const code = typeof data.code === 'number' ? data.code : -1;
  if (code !== 0) {
    const msg = String(data.msg ?? data.message ?? '未知错误');
    // 业务错误（如 101 文章已被发布者删除）直接透传原因；只有疑似
    // 鉴权/余额类问题才附排查提示，避免所有错误都误导用户去查 key。
    const hint = /key|余额|欠费|充值|权限|登录/i.test(msg) ? '（检查 DAJIALA_API_KEY / 余额）' : '';
    throw new DajialaError(`${feed}：${msg}${hint}`);
  }
}

const stripHtml = (s: unknown): string => String(s ?? '').replace(/<[^>]+>/g, '');

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

type RawItem = Record<string, unknown>;

function extractHotItems(data: Record<string, unknown>): RawItem[] {
  let items: unknown = data.data ?? data.list ?? [];
  if (items && !Array.isArray(items) && typeof items === 'object') {
    const obj = items as Record<string, unknown>;
    items = obj.list ?? obj.items ?? [];
  }
  return Array.isArray(items) ? (items as RawItem[]) : [];
}

function hotItemToHit(it: RawItem): MediaTopicHit {
  return {
    title: stripHtml(it.title) || '（无标题）',
    url: String(it.url ?? ''),
    account: String(it.mp_nickname ?? '') || '（未知公众号）',
    publishedAt: String(it.pub_time ?? ''),
    signals: ['trending'],
    readNum: Number.isFinite(Number(it.read_num)) ? Number(it.read_num) : null,
    zanNum: Number.isFinite(Number(it.zan_num)) ? Number(it.zan_num) : null,
    hot: it.hot !== undefined && it.hot !== null && String(it.hot) !== '' ? String(it.hot) : null,
    desc: null,
  };
}

function extractRealtimeItems(data: Record<string, unknown>): RawItem[] {
  const out: RawItem[] = [];
  const blocks = Array.isArray(data.data) ? data.data : [];
  for (const box of blocks as Array<Record<string, unknown>>) {
    const items = Array.isArray(box?.items) ? (box.items as RawItem[]) : [];
    out.push(...items);
  }
  return out;
}

function realtimeItemToHit(it: RawItem): MediaTopicHit {
  const source = (it.source ?? {}) as Record<string, unknown>;
  const desc = stripHtml(it.desc).replace(/\s+/g, ' ').trim();
  return {
    title: stripHtml(it.title) || '（无标题）',
    url: String(it.doc_url ?? ''),
    account: String(source.title ?? '') || '（未知公众号）',
    publishedAt: String(source.dateTime ?? ''),
    signals: ['realtime'],
    readNum: null,
    zanNum: null,
    hot: null,
    desc: desc ? desc.slice(0, 140) : null,
  };
}

export async function dajialaHotSearch(
  apiKey: string,
  opts: { keyword?: string; days?: number; page?: number },
): Promise<MediaTopicHit[]> {
  const form = new FormData();
  form.append('key', apiKey);
  form.append('keyword', opts.keyword ?? '');
  form.append('pub_type', '0');
  form.append('category', '0');
  form.append('page', String(opts.page ?? 1));
  form.append('start_time', isoDaysAgo(Math.max(1, opts.days ?? 7)));
  form.append('end_time', isoDaysAgo(0));
  const data = await postWithRetry(HOT_URL, () => ({ method: 'POST', body: form }));
  requireOk(data, '爆文榜');
  return extractHotItems(data)
    .map(hotItemToHit)
    .sort((a, b) => (b.readNum ?? 0) - (a.readNum ?? 0));
}

export async function dajialaWebSearch(
  apiKey: string,
  opts: { keyword: string; sort?: string },
): Promise<MediaTopicHit[]> {
  const body = {
    mode: 2,
    keyword: opts.keyword,
    BusinessType: 2,
    Sub_search_type: SORT_MAP[opts.sort ?? 'hottest'] ?? 4,
    currentPage: 1,
    offset: 0,
    cookies_buffer: '',
    key: apiKey,
    verifycode: '',
  };
  const data = await postWithRetry(WEB_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  requireOk(data, '搜一搜');
  return extractRealtimeItems(data).map(realtimeItemToHit);
}

/** URL 的 mid+idx+sn 唯一定位一篇公众号文章；拿不到就用归一化标题。 */
function hitKey(hit: MediaTopicHit): string {
  const m = hit.url.match(/mid=(\w+).*?idx=(\d+).*?sn=(\w+)/);
  if (m) return `u:${m[1]}_${m[2]}_${m[3]}`;
  return `t:${hit.title.toLowerCase().replace(/[\s\W_]+/g, '')}`;
}

/** 抓取单篇公众号文章正文（article_detail 直调）——素材简报的原料。 */
export async function dajialaArticleDetail(
  apiKey: string,
  url: string,
): Promise<{ title: string; account: string; markdown: string }> {
  const params = new URLSearchParams({ url, key: apiKey, mode: '1' });
  const data = await postWithRetry(`https://www.dajiala.com/fbmain/monitor/v3/article_detail?${params}`, () => ({
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }));
  requireOk(data, '原文抓取');
  const html = String(data.content ?? '');
  const markdown = html
    .replace(/<img[^>]*src="([^"]+)"[^>]*\/?>/g, '\n![图]($1)\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<p[^>]*>/g, '')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: stripHtml(data.title) || '（无标题）',
    account: String(data.nick_name ?? ''),
    markdown,
  };
}

/** 双信号雷达：合并爆文榜与搜一搜，⭐双命中排最前。任一路失败则单路降级。 */
export async function dajialaRadar(
  apiKey: string,
  opts: { keyword: string; days?: number },
): Promise<{ items: MediaTopicHit[]; sources: Array<'trending' | 'realtime'> }> {
  const [trending, realtime] = await Promise.allSettled([
    dajialaHotSearch(apiKey, { keyword: opts.keyword, days: opts.days ?? 7 }),
    dajialaWebSearch(apiKey, { keyword: opts.keyword, sort: 'hottest' }),
  ]);
  const sources: Array<'trending' | 'realtime'> = [];
  const bucket = new Map<string, MediaTopicHit>();
  if (trending.status === 'fulfilled') {
    sources.push('trending');
    for (const hit of trending.value) bucket.set(hitKey(hit), hit);
  }
  if (realtime.status === 'fulfilled') {
    sources.push('realtime');
    for (const hit of realtime.value) {
      const key = hitKey(hit);
      const existing = bucket.get(key);
      if (existing) {
        existing.signals = ['trending', 'realtime'];
        if (!existing.desc && hit.desc) existing.desc = hit.desc;
      } else {
        bucket.set(key, hit);
      }
    }
  }
  if (sources.length === 0) {
    const err = trending.status === 'rejected' ? trending.reason : null;
    throw err instanceof Error ? err : new DajialaError('两路数据源都失败了');
  }
  const rank = (h: MediaTopicHit) => (h.signals.length === 2 ? 0 : h.signals[0] === 'trending' ? 1 : 2);
  const items = [...bucket.values()].sort((a, b) => rank(a) - rank(b) || (b.readNum ?? 0) - (a.readNum ?? 0));
  return { items, sources };
}

// ---- 2026-07-07 接口调研新增（均已真实调用验证，参数以实测为准） ----

const SUG_URL = 'https://www.dajiala.com/fbmain/monitor/v3/web_search_sug';
const KWDB_URL = 'https://www.dajiala.com/fbmain/monitor/v3/kw_search';
const HISTORY_URL = 'https://www.dajiala.com/fbmain/monitor/v3/post_history';

/** 微信搜一搜联想词——亿级用户的真实搜索需求词（参数 keyword，实测返回 data.sug_words）。 */
export async function dajialaSugWords(apiKey: string, keyword: string): Promise<string[]> {
  const data = await postWithRetry(SUG_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, key: apiKey, cookies_buffer: '', verifycode: '' }),
  }));
  requireOk(data, '需求词');
  const inner = (data.data ?? {}) as Record<string, unknown>;
  const words = inner.sug_words;
  return Array.isArray(words) ? words.map((w) => String(w)).filter(Boolean).slice(0, 12) : [];
}

/** 全库文章搜索（数据库，按条计费）——带真实阅读/赞/在看，适合竞品同题调研（参数 kw，实测）。 */
export async function dajialaKwSearch(
  apiKey: string,
  opts: { keyword: string; page?: number },
): Promise<MediaTopicHit[]> {
  const data = await postWithRetry(KWDB_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kw: opts.keyword, key: apiKey, page: opts.page ?? 1 }),
  }));
  requireOk(data, '全库搜索');
  const items = Array.isArray(data.data) ? (data.data as RawItem[]) : [];
  return items
    .map((it) => ({
      title: stripHtml(it.title) || '（无标题）',
      url: String(it.short_link ?? it.url ?? ''),
      account: String(it.wx_name ?? '') || '（未知公众号）',
      publishedAt: String(it.publish_time_str ?? ''),
      signals: ['kwdb'] as MediaTopicHit['signals'],
      readNum: Number(it.read ?? 0) || null,
      zanNum: Number(it.praise ?? 0) || null,
      hot: null,
      desc: stripHtml(it.content).replace(/\s+/g, ' ').trim().slice(0, 140) || null,
    }))
    .sort((a, b) => (b.readNum ?? 0) - (a.readNum ?? 0));
}

/** 对标账号最新发文（参数 name，实测；每号一页 5 条）。多号并行，单号失败静默跳过。 */
export async function dajialaPeersLatest(
  apiKey: string,
  accounts: string[],
): Promise<MediaTopicHit[]> {
  const names = accounts.map((a) => a.trim()).filter(Boolean).slice(0, 5);
  const settled = await Promise.allSettled(
    names.map(async (name) => {
      const data = await postWithRetry(HISTORY_URL, () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, key: apiKey, page: 1 }),
      }));
      requireOk(data, `对标「${name}」`);
      const items = Array.isArray(data.data) ? (data.data as RawItem[]) : [];
      return items.slice(0, 5).map((it) => ({
        title: stripHtml(it.title) || '（无标题）',
        url: String(it.url ?? ''),
        account: name,
        publishedAt: String(it.post_time_str ?? ''),
        signals: ['peer'] as MediaTopicHit['signals'],
        readNum: null,
        zanNum: null,
        hot: null,
        desc: stripHtml(it.digest).trim().slice(0, 140) || null,
      }));
    }),
  );
  const hits: MediaTopicHit[] = [];
  for (const s of settled) if (s.status === 'fulfilled') hits.push(...s.value);
  if (hits.length === 0 && settled.some((s) => s.status === 'rejected')) {
    const first = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    throw first.reason instanceof Error ? first.reason : new DajialaError(String(first.reason));
  }
  return hits.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

const READ_ZAN_PRO_URL = 'https://www.dajiala.com/fbmain/monitor/v3/read_zan_pro';
const COMMENT_URL = 'https://www.dajiala.com/fbmain/monitor/v3/article_comment2';
const RANK_URL = 'https://www.dajiala.com/fbmain/rank/v1/get_account_type_rank';

export interface ArticleEngagement {
  read: number;
  zan: number;
  looking: number;
  share: number;
  collect: number;
  comment: number;
}

/** 六维互动数据（实测字段 read/zan/looking/share_num/collect_num/comment_count）——转发数是选题传播力金标准。 */
export async function dajialaReadZanPro(apiKey: string, url: string): Promise<ArticleEngagement> {
  const data = await postWithRetry(READ_ZAN_PRO_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, key: apiKey, verifycode: '' }),
  }));
  requireOk(data, '互动数据');
  const d = (data.data ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    read: n(d.read),
    zan: n(d.zan),
    looking: n(d.looking),
    share: n(d.share_num),
    collect: n(d.collect_num),
    comment: n(d.comment_count),
  };
}

export interface ArticleComment {
  content: string;
  likes: number;
}

/** 文章一级评论（读者真实疑问=切入角度）。字段名宽松映射，最多取 30 条。 */
export async function dajialaComments(apiKey: string, url: string): Promise<ArticleComment[]> {
  const data = await postWithRetry(COMMENT_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, key: apiKey, verifycode: '' }),
  }));
  requireOk(data, '评论区');
  const items = Array.isArray(data.data) ? (data.data as RawItem[]) : [];
  return items
    .map((it) => ({
      content: stripHtml(it.content ?? it.comment_content ?? it.nick_comment ?? '').trim(),
      likes: Number(it.like_num ?? it.praise_num ?? it.likeNum ?? 0) || 0,
    }))
    .filter((c) => c.content.length > 0)
    .slice(0, 30);
}

export interface RankedAccount {
  rank: number;
  name: string;
  wxid: string;
  avgRead: number | null;
  avgTopRead: number | null;
  postTotal: number | null;
  index: string | null;
}

/** 公众号类目榜（实测外层是 error_code 而非 code；空参=默认总榜，type/page 原样透传）。 */
export async function dajialaAccountRank(
  apiKey: string,
  opts: { type?: number; page?: number },
): Promise<RankedAccount[]> {
  const data = await postWithRetry(RANK_URL, () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: apiKey,
      ...(opts.type != null ? { type: opts.type } : {}),
      ...(opts.page != null ? { page: opts.page } : {}),
    }),
  }));
  const errCode = String(data.error_code ?? data.code ?? '-1');
  if (errCode !== '0') {
    throw new DajialaError(`榜单返回 error_code=${errCode}: ${String(data.msg ?? '未知错误')}`);
  }
  const outer = (data.data ?? {}) as Record<string, unknown>;
  const items = Array.isArray(outer.data) ? (outer.data as RawItem[]) : [];
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v) || null);
  return items.map((it) => ({
    rank: Number(it.rank ?? 0) || 0,
    name: String(it.mp_name ?? '（未知）'),
    wxid: String(it.wxid ?? ''),
    avgRead: num(it.avg_readnum),
    avgTopRead: num(it.avg_top_readnum),
    postTotal: num(it.post_total),
    index: it.dajiala_index != null ? String(it.dajiala_index) : null,
  }));
}
