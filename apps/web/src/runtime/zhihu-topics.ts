// 知乎原生选题运行时（2026-07-12）。用桌面端登录态分区 session 直取知乎自己
// 的接口（热榜/实时热搜/联想词/综合搜索），比 TikHub 第三方聚合更准更实时。
// 接口与返回结构见 docs/zhihu-topic-apis.md（内置浏览器实测）。
//
// 仅桌面端可用（靠 host 桥 sessionFetch，带 od-browser-zhihu-<账号> 分区
// cookie）。只在用户点击时取——不轮询、不批量（风控与合规）。
import { hostBrowserSessionFetch } from '@open-design/host';
import type { MediaTopicHit } from '@open-design/contracts';

export type ZhihuSource = 'hot' | 'searchHot' | 'suggest' | 'search';

export const ZHIHU_SOURCES: Array<{ id: ZhihuSource; label: string; needsKeyword: boolean }> = [
  { id: 'hot', label: '热榜', needsKeyword: false },
  { id: 'searchHot', label: '实时热搜', needsKeyword: false },
  { id: 'suggest', label: '联想词', needsKeyword: true },
  { id: 'search', label: '搜索', needsKeyword: true },
];

/** api.zhihu.com/questions/<id> → www.zhihu.com/question/<id>（网页可点）。 */
function normalizeZhihuUrl(raw: string): string {
  if (!raw) return '';
  return raw
    .replace('//api.zhihu.com/questions/', '//www.zhihu.com/question/')
    .replace('//api.zhihu.com/answers/', '//www.zhihu.com/answer/')
    .replace('//api.zhihu.com/articles/', '//zhuanlan.zhihu.com/p/');
}

function searchLink(q: string): string {
  return `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(q)}`;
}

function urlFor(source: ZhihuSource, keyword: string): string {
  const q = encodeURIComponent(keyword.trim());
  switch (source) {
    case 'hot':
      return 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true';
    case 'searchHot':
      return 'https://www.zhihu.com/api/v4/search/hot_search';
    case 'suggest':
      return `https://www.zhihu.com/api/v4/search/suggest?q=${q}`;
    case 'search':
      return `https://www.zhihu.com/api/v4/search_v3?t=general&q=${q}&correction=1&offset=0&limit=20&search_source=Normal`;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
/** 知乎搜索结果的 title/excerpt 带 <em> 高亮标签，UI 按纯文本渲染，得剥掉。 */
const stripHtml = (v: unknown): string => str(v).replace(/<[^>]+>/g, '');

function mapHot(json: any): MediaTopicHit[] {
  return (json?.data ?? []).flatMap((row: any) => {
    const t = row?.target ?? {};
    if (!t.title) return [];
    return [{
      title: str(t.title),
      url: normalizeZhihuUrl(str(t.url)),
      account: '',
      publishedAt: '',
      signals: ['trending'] as MediaTopicHit['signals'],
      readNum: num(t.follower_count),
      zanNum: null,
      hot: str(row?.detail_text) || null,
      desc: str(t.excerpt).slice(0, 80) || (t.answer_count ? `${t.answer_count} 回答` : null),
    }];
  });
}

function mapSearchHot(json: any): MediaTopicHit[] {
  return (json?.hot_search_queries ?? []).flatMap((row: any) => {
    const q = str(row?.real_query || row?.query);
    if (!q) return [];
    return [{
      title: q,
      url: searchLink(q),
      account: '',
      publishedAt: '',
      signals: ['realtime'] as MediaTopicHit['signals'],
      readNum: null,
      zanNum: null,
      hot: row?.hot != null ? String(row.hot) : null,
      desc: '实时热搜',
    }];
  });
}

function mapSuggest(json: any): MediaTopicHit[] {
  return (json?.suggest ?? []).flatMap((row: any) => {
    const q = str(row?.query);
    if (!q) return [];
    return [{
      title: q,
      url: searchLink(q),
      account: '',
      publishedAt: '',
      signals: ['realtime'] as MediaTopicHit['signals'],
      readNum: null,
      zanNum: null,
      hot: null,
      desc: '读者搜索词 · 天然选题角度',
    }];
  });
}

function mapSearch(json: any): MediaTopicHit[] {
  return (json?.data ?? [])
    .filter((row: any) => row?.type === 'search_result' && row?.object)
    .flatMap((row: any) => {
      const o = row.object;
      const title = stripHtml(o.title) || stripHtml(o.question?.name) || stripHtml(o.question?.title);
      if (!title) return [];
      return [{
        title,
        url: normalizeZhihuUrl(str(o.url)),
        account: str(o.author?.name),
        publishedAt: '',
        signals: ['kwdb'] as MediaTopicHit['signals'],
        readNum: null,
        zanNum: num(o.voteup_count),
        hot: null,
        desc: stripHtml(o.excerpt).slice(0, 80) || null,
      }];
    });
}

const MAPPERS: Record<ZhihuSource, (j: any) => MediaTopicHit[]> = {
  hot: mapHot,
  searchHot: mapSearchHot,
  suggest: mapSuggest,
  search: mapSearch,
};

/** 取一个知乎原生选题源。返回 MediaTopicHit[] 或 { error }（选题台提示）。 */
export async function fetchZhihuTopics(
  account: string,
  source: ZhihuSource,
  keyword = '',
): Promise<MediaTopicHit[] | { error: string }> {
  const meta = ZHIHU_SOURCES.find((s) => s.id === source);
  if (meta?.needsKeyword && !keyword.trim()) {
    return { error: '先填一个方向词再搜' };
  }
  const resp = await hostBrowserSessionFetch({ platform: 'zhihu', account, url: urlFor(source, keyword) });
  if (!resp.ok) return { error: `取知乎数据失败：${resp.reason}` };
  if (resp.status !== 200) return { error: `知乎返回 ${resp.status}——可能未登录或触发风控，去「账号」页确认知乎登录` };
  let json: unknown;
  try {
    json = JSON.parse(resp.body);
  } catch {
    return { error: '知乎返回非预期内容（可能是登录/验证页）——去后台确认知乎登录态' };
  }
  const items = MAPPERS[source](json);
  return items;
}
