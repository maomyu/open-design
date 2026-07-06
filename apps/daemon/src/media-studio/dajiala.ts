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
    throw new DajialaError(`${feed}返回 code=${code}: ${msg}（检查 DAJIALA_API_KEY / 余额）`);
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
