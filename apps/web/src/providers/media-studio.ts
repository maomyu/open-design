// Media Studio API client — thin fetch wrappers over
// /api/media-studio/* (see apps/daemon/src/media-studio-routes.ts and
// specs/current/media-studio.md). Same conventions as providers/daemon.ts:
// null / {error} returns instead of throws, contracts DTOs end to end.
import type {
  CreateMediaArticleRequest,
  CreateMediaKnowledgeRequest,
  CreateMediaSnippetRequest,
  CreateMediaTopicRequest,
  MediaArticleVersion,
  MediaKnowledge,
  GenerateArticleImageRequest,
  GenerateArticleImageResponse,
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaRenderRequest,
  MediaRenderResponse,
  MediaSnippet,
  MediaTopic,
  CreateStudioCollectRequest,
  StudioCollectJob,
  StudioAiTaskRequest,
  StudioAiTaskResponse,
  TopicFeedSearchRequest,
  TopicFeedSearchResponse,
  UpdateMediaArticleRequest,
  UpdateMediaTopicRequest,
} from '@open-design/contracts';
import { isOpenDesignHostBrowserAvailable, openHostBrowserProfile } from '@open-design/host';
import { BROWSER_PLATFORM_TITLES, normalizeBrowserPlatform, openBrowserPane } from '../runtime/browser-panes';

const ROOT = '/api/media-studio';

async function errorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const data = (await resp.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch { /* keep fallback */ }
  return `${fallback} (${resp.status})`;
}

export async function fetchStudioArticles(platform: string): Promise<MediaArticleSummary[] | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { articles?: MediaArticleSummary[] };
    return data.articles ?? [];
  } catch {
    return null;
  }
}

export async function fetchStudioArticle(platform: string, id: string): Promise<MediaArticle | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { article?: MediaArticle };
    return data.article ?? null;
  } catch {
    return null;
  }
}

export async function createStudioArticle(
  platform: string,
  body: CreateMediaArticleRequest,
): Promise<MediaArticle | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { article?: MediaArticle };
    return data.article ?? null;
  } catch {
    return null;
  }
}

export async function updateStudioArticle(
  platform: string,
  id: string,
  patch: UpdateMediaArticleRequest,
): Promise<MediaArticle | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { article?: MediaArticle };
    return data.article ?? null;
  } catch {
    return null;
  }
}

export async function deleteStudioArticle(platform: string, id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Stateless render — live preview + standalone 排版 mode. */
export async function renderStudioPreview(body: MediaRenderRequest): Promise<MediaRenderResponse | null> {
  try {
    const resp = await fetch(`${ROOT}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as MediaRenderResponse;
  } catch {
    return null;
  }
}

/** Render + persist（「保存排版」）. */
export async function renderStudioArticle(
  platform: string,
  id: string,
  skin?: string,
): Promise<(MediaRenderResponse & { article?: MediaArticle }) | null> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(id)}/render`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(skin ? { skin } : {}),
      },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as MediaRenderResponse & { article?: MediaArticle };
  } catch {
    return null;
  }
}

export async function publishStudioArticle(
  platform: string,
  id: string,
  accountId: string,
): Promise<{ record?: MediaPublishRecord; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(id)}/publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      },
    );
    const data = (await resp.json().catch(() => ({}))) as {
      record?: MediaPublishRecord;
      article?: MediaArticle;
      error?: string;
    };
    if (!resp.ok) {
      return { ...(data.record ? { record: data.record } : {}), error: data.error ?? `发布失败 (${resp.status})` };
    }
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function fetchStudioPublishes(platform: string, articleId: string): Promise<MediaPublishRecord[]> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/publishes`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { publishes?: MediaPublishRecord[] };
    return data.publishes ?? [];
  } catch {
    return [];
  }
}

export async function fetchStudioTopics(platform: string): Promise<MediaTopic[] | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { topics?: MediaTopic[] };
    return data.topics ?? [];
  } catch {
    return null;
  }
}

export async function createStudioTopic(
  platform: string,
  body: CreateMediaTopicRequest,
): Promise<MediaTopic | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { topic?: MediaTopic };
    return data.topic ?? null;
  } catch {
    return null;
  }
}

// ── 真抓爆款·直接采集管线(纯可视化,不经 AI 智能体/插件) ──
// ① createStudioCollect 发起内置浏览器采集(桌面端 collect-listener 会开可见标签逐平台搜)。
// ② waitStudioCollectDone 轮询到各平台采完。③ radarScoreCollected 把采集条目交引擎 --radar 评分。
export async function createStudioCollect(
  body: CreateStudioCollectRequest,
): Promise<{ jobId: string } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = (await resp.json()) as { job?: StudioCollectJob; id?: string; error?: string };
    if (!resp.ok) return { error: d.error || '发起采集失败(桌面端需在运行)' };
    const jobId = d.job?.id ?? d.id ?? '';
    return jobId ? { jobId } : { error: '未取到采集任务号' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 轮询采集任务到终态(done/error);采集在桌面端【可见标签】里逐平台跑,期间浏览器前台可见。
 *  用 /wait 的【长轮询 + since 游标】拿 progress 增量:采集端(BrowserPanesHost.runCollect)
 *  每步 reportCollectProgress 写进 job.progress,这里通过 onProgress 把它顶到选题页显示——
 *  尤其"撞验证码/需登录"这种要用户动手的提示,必须让用户在应用里看得见(2026-07-14 用户报
 *  "抖音撞验证码要停下等用户 + 要有提示")。采集(抖音含首页暖场/拟人输入/验证码等待)可能几
 *  分钟,故上限放到 ~6 分钟。 */
export async function waitStudioCollectDone(
  jobId: string,
  onProgress?: (message: string, job: StudioCollectJob) => void,
): Promise<StudioCollectJob | null> {
  let cursor = 0;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    try {
      // since=cursor:服务端阻塞到有新 progress / 终态 / 超时(20s)才返回,天然节流。
      const resp = await fetch(
        `${ROOT}/collect/${encodeURIComponent(jobId)}/wait?since=${cursor}&timeoutMs=20000`,
      );
      if (resp.ok) {
        const d = (await resp.json()) as { job?: StudioCollectJob; cursor?: number } & StudioCollectJob;
        const job = (d.job ?? d) as StudioCollectJob;
        if (onProgress && Array.isArray(job.progress)) {
          for (const line of job.progress) if (line) onProgress(line, job);
        }
        if (typeof d.cursor === 'number') cursor = d.cursor;
        if (job.status === 'done' || job.status === 'error') return job;
      }
    } catch {
      /* 单次网络抖动忽略,下一轮再试;不要因一次失败就整体放弃 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/**
 * 【TikHub 直采选题】真抓爆款主通道:给关键词+平台+爆款标准,daemon 让引擎走 TikHub 搜索
 * (翻页累积→按标准筛→评分)秒出选题候选。取代"开内置浏览器逐平台搜+抓卡片"的老路——
 * 更快、字段更全(带粉丝/评论/真视频id可下载)、无登录/验证码/滚动/改版问题。
 */
export async function collectScoreTopics(
  keyword: string,
  platforms: string[],
  criteria?: unknown,
  pages = 1,
  /** 小红书内容类型:'image' 图文(图文笔记台)/'video' 视频(短视频台)——前后端对应图文笔记模块。 */
  xhsContentType?: 'image' | 'video',
): Promise<{ topics: Array<Record<string, unknown>>; count: number; tier?: string | null } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/collect-score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, platforms, pages, ...(criteria ? { criteria } : {}), ...(xhsContentType ? { xhsContentType } : {}) }),
    });
    const d = (await resp.json()) as { topics?: Array<Record<string, unknown>>; count?: number; error?: string; tier?: string | null };
    if (!resp.ok) return { error: d.error || 'TikHub 采集/评分失败' };
    return { topics: d.topics ?? [], count: d.count ?? 0, tier: d.tier ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 图文笔记台「提取图文仿写」:把采集时随这条爆款带回的原图直链下到图集(text/images 均取自
 *  用户点的那条搜索结果,保证一致)。返回下好的图集资产 URL。 */
export async function importXhsNote(
  articleId: string,
  text: string,
  images: string[],
): Promise<{ text: string; imageUrls: string[] } | { error: string }> {
  try {
    const resp = await fetchWithTimeout(`${ROOT}/import-xhs-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, text, images }),
    }, 90_000);
    const d = (await resp.json()) as { text?: string; imageUrls?: string[]; error?: string };
    if (!resp.ok) return { error: d.error || '下载图文失败' };
    return { text: d.text ?? text, imageUrls: d.imageUrls ?? [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 把采集到的条目 { 平台: [条目] } 交爆款引擎 --radar 评分,返回选题候选。 */
export async function radarScoreCollected(
  keyword: string,
  items: Record<string, unknown[]>,
  criteria?: unknown,
): Promise<{ topics: Array<Record<string, unknown>>; count: number } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/radar-score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, items, criteria }),
    });
    const d = (await resp.json()) as { topics?: Array<Record<string, unknown>>; count?: number; error?: string };
    if (!resp.ok) return { error: d.error || '评分失败' };
    return { topics: d.topics ?? [], count: d.count ?? 0 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 下载某爆款的原视频(yt-dlp),返回本地文件路径。给用户仿写文案用。 */
/** fetch + 超时自动中止:任何一步 daemon 卡住都不会让 UI 无限转圈(用户报"提取仿写一直转圈"
 *  的兜底)。超时抛 AbortError,上层 catch 转成友好文案。 */
async function fetchWithTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function timeoutMsg(e: unknown, fallback: string): string {
  if (e instanceof DOMException && e.name === 'AbortError') return fallback;
  return e instanceof Error ? e.message : String(e);
}

export async function downloadStudioVideo(
  url: string,
  cookieFile?: string,
): Promise<{ file: string; dir: string } | { error: string }> {
  try {
    // 180s 上限:大视频(小红书/B站可达上百 MB)也够下完,卡死则超时报错而非永久转圈。
    const resp = await fetchWithTimeout(`${ROOT}/download-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ...(cookieFile ? { cookieFile } : {}) }),
    }, 180_000);
    const d = (await resp.json()) as { file?: string; dir?: string; error?: string };
    if (!resp.ok || !d.file) return { error: d.error || '下载失败' };
    return { file: d.file, dir: d.dir ?? '' };
  } catch (e) {
    return { error: timeoutMsg(e, '下载超时(视频过大或网络慢)——换条短一点的爆款再试') };
  }
}

/** 「边播边抓」抓到媒体直链后,让 daemon 带 Referer 下载保存。 */
export async function downloadVideoByUrl(
  mediaUrl: string,
  referer: string,
  title: string,
): Promise<{ file: string; dir: string } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/download-video-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaUrl, referer, title }),
    });
    const d = (await resp.json()) as { file?: string; dir?: string; error?: string };
    if (!resp.ok || !d.file) return { error: d.error || '下载失败' };
    return { file: d.file, dir: d.dir ?? '' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 已下载爆款原视频的可播放 URL(供 <video> 预览用)。
 * 传 daemon 下载接口返回的绝对路径或文件名,取 basename 拼到 download-file 路由。
 */
export function downloadedVideoUrl(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return `${ROOT}/download-file/${encodeURIComponent(base)}`;
}

/**
 * 把已下载视频整体 fetch 成 blob 并返回 objectURL,供 <video src> 用。
 * 为什么不直接 <video src={apiUrl}>:packaged 下网页走 od:// 协议,<video> 自己发的
 * Range 请求要穿 od://→web-sidecar→daemon 三层代理,206/Range 透传不稳,常表现为
 * "下下来了却放不出来"。改成 fetch 整块(走的是稳的 fetch 代理)→ createObjectURL,
 * <video> 直接吃本地 blob,绕开 Range 问题。仿写用的短视频通常几 MB,一次性拉没压力。
 * 返回 { url, revoke };失败返回 null(调用方回退到 apiUrl 或提示)。
 */
export async function fetchDownloadedVideoObjectUrl(
  file: string,
): Promise<{ url: string; revoke: () => void } | null> {
  try {
    const base = file.split(/[\\/]/).pop() ?? file;
    const resp = await fetch(`${ROOT}/download-file/${encodeURIComponent(base)}`);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (blob.size < 1024) return null; // 太小=不是有效视频
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  } catch {
    return null;
  }
}

/** 本地视频文件 → 口播文案(抽音频+ASR)。仿写用。 */
/** B站视频「存草稿」全自动:daemon 用登录 cookie 直连 upos 上传 API 建草稿(绕开网页上传器)。 */
export async function submitBilibiliDraft(
  videoFile: string, title: string, desc: string, tags: string, cookieFile: string, coverPath = '',
): Promise<{ ok: true; draftId: unknown } | { error: string }> {
  try {
    // 360s:B站上传大视频较慢;超时中止而非无限转圈。
    const resp = await fetchWithTimeout(`${ROOT}/bilibili-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoFile, title, desc, tags, cookieFile, coverPath }),
    }, 360_000);
    const d = (await resp.json()) as { ok?: boolean; draftId?: unknown; error?: string };
    if (!resp.ok || !d.ok) return { error: d.error || 'B站存草稿失败' };
    return { ok: true, draftId: d.draftId };
  } catch (e) {
    return { error: timeoutMsg(e, 'B站上传超时(视频过大或网络慢)——换条短一点的再试') };
  }
}

export async function extractScriptFromVideo(
  videoFile: string,
): Promise<{ transcript: string } | { error: string }> {
  try {
    // 320s 上限:略高于 daemon 侧 300s ASR 超时,让 daemon 的具体错误先浮上来;真卡死也会中止。
    const resp = await fetchWithTimeout(`${ROOT}/extract-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoFile }),
    }, 320_000);
    const d = (await resp.json()) as { transcript?: string; error?: string };
    if (!resp.ok) return { error: d.error || '提取文案失败' };
    return { transcript: d.transcript ?? '' };
  } catch (e) {
    return { error: timeoutMsg(e, '提取文案超时——视频过长,换条短一点的口播爆款再试') };
  }
}

export async function updateStudioTopic(
  platform: string,
  id: string,
  patch: UpdateMediaTopicRequest,
): Promise<MediaTopic | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { topic?: MediaTopic };
    return data.topic ?? null;
  } catch {
    return null;
  }
}

export async function deleteStudioTopic(platform: string, id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function fetchStudioSnippets(platform: string): Promise<MediaSnippet[]> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/snippets`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { snippets?: MediaSnippet[] };
    return data.snippets ?? [];
  } catch {
    return [];
  }
}

export async function createStudioSnippet(
  platform: string,
  body: CreateMediaSnippetRequest,
): Promise<MediaSnippet | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/snippets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { snippet?: MediaSnippet };
    return data.snippet ?? null;
  } catch {
    return null;
  }
}

export async function deleteStudioSnippet(platform: string, id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/snippets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export type TopicFeedKind = 'hot-search' | 'web-search' | 'radar' | 'kw-search' | 'sug' | 'peers';

/** 大家来数据接口（daemon 直调）。返回 {error} 而不是抛异常。 */
export async function searchTopicFeed(
  platform: string,
  feed: TopicFeedKind,
  body: TopicFeedSearchRequest,
): Promise<TopicFeedSearchResponse | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/${feed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: await errorMessage(resp, '数据接口调用失败') };
    return (await resp.json()) as TopicFeedSearchResponse;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export interface TopicEngagement {
  read: number;
  zan: number;
  looking: number;
  share: number;
  collect: number;
  comment: number;
}

export async function verifyTopicEngagement(
  platform: string,
  url: string,
): Promise<{ engagement?: TopicEngagement; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await resp.json().catch(() => ({}))) as { engagement?: TopicEngagement; error?: string };
    if (!resp.ok) return { error: data.error ?? `验证失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function fetchTopicComments(
  platform: string,
  url: string,
): Promise<{ comments?: Array<{ content: string; likes: number }>; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      comments?: Array<{ content: string; likes: number }>;
      error?: string;
    };
    if (!resp.ok) return { error: data.error ?? `拉评论失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export interface RankedAccountRow {
  rank: number;
  name: string;
  wxid: string;
  avgRead: number | null;
  avgTopRead: number | null;
  postTotal: number | null;
  index: string | null;
}

export async function fetchAccountRank(
  platform: string,
  body?: { type?: number; page?: number },
): Promise<{ accounts?: RankedAccountRow[]; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/account-rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await resp.json().catch(() => ({}))) as { accounts?: RankedAccountRow[]; error?: string };
    if (!resp.ok) return { error: data.error ?? `拉榜单失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function generateArticleImage(
  platform: string,
  articleId: string,
  body: GenerateArticleImageRequest,
): Promise<GenerateArticleImageResponse | { error: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/images`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) return { error: await errorMessage(resp, '生图失败') };
    return (await resp.json()) as GenerateArticleImageResponse;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

/** 组一个步骤级 AI 任务（提示词+会话）；执行由调用方走 /api/runs。 */
export async function createStudioAiTask(
  platform: string,
  body: StudioAiTaskRequest,
): Promise<StudioAiTaskResponse | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/ai-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: await errorMessage(resp, 'AI 任务创建失败') };
    return (await resp.json()) as StudioAiTaskResponse;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

// ---- 敏感词扫描 ----

export interface StudioLintHit {
  word: string;
  category: string;
  context: string;
  count: number;
}

export async function lintStudioArticle(platform: string, articleId: string): Promise<StudioLintHit[]> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/lint`,
      { method: 'POST' },
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as { hits?: StudioLintHit[] };
    return data.hits ?? [];
  } catch {
    return [];
  }
}

// ---- 版本历史 ----

export async function fetchStudioVersions(platform: string, articleId: string): Promise<MediaArticleVersion[]> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/versions`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { versions?: MediaArticleVersion[] };
    return data.versions ?? [];
  } catch {
    return [];
  }
}

export async function saveStudioVersion(platform: string, articleId: string, label: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function restoreStudioVersion(
  platform: string,
  articleId: string,
  versionId: string,
): Promise<MediaArticle | null> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: 'POST' },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { article?: MediaArticle };
    return data.article ?? null;
  } catch {
    return null;
  }
}

// ---- 本机上传 ----

export async function uploadStudioAsset(
  platform: string,
  articleId: string,
  file: File,
): Promise<{ url?: string; error?: string }> {
  try {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/upload-asset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64: btoa(binary) }),
      },
    );
    const data = (await resp.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!resp.ok) return { error: data.error ?? `上传失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

// ---- 知识库 ----

export async function fetchStudioKnowledge(platform: string): Promise<MediaKnowledge[]> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/knowledge`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { items?: MediaKnowledge[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function createStudioKnowledge(
  platform: string,
  body: CreateMediaKnowledgeRequest,
): Promise<MediaKnowledge | null> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { item?: MediaKnowledge };
    return data.item ?? null;
  } catch {
    return null;
  }
}

export async function deleteStudioKnowledge(platform: string, id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/knowledge/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---- short-video: 配音 / 登录态 / 矩阵发布 ----

/** 上传封面图(发布页),存进作品素材目录并记 extra.coverPath;一键存草稿时自动传到抖音封面。 */
export async function uploadStudioCover(
  platform: string,
  articleId: string,
  file: File,
): Promise<{ path?: string; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/upload-cover`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      },
    );
    const data = (await resp.json().catch(() => ({}))) as { path?: string; article?: MediaArticle; error?: string };
    if (!resp.ok) return { error: data.error ?? `封面上传失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function uploadStudioVideo(
  platform: string,
  articleId: string,
  file: File,
): Promise<{ path?: string; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/upload-video`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    const data = (await resp.json().catch(() => ({}))) as { path?: string; article?: MediaArticle; error?: string };
    if (!resp.ok) return { error: data.error ?? `上传失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function synthesizeStudioTts(
  platform: string,
  articleId: string,
  body: { text?: string; voice?: string; preview?: boolean },
): Promise<{ url?: string; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/tts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const data = (await resp.json().catch(() => ({}))) as { url?: string; article?: MediaArticle; error?: string };
    if (!resp.ok) return { error: data.error ?? `配音失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function checkSauLogin(
  platform: string,
  target: { platform: string; account: string },
): Promise<{ loggedIn?: boolean; detail?: string; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/sau/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const data = (await resp.json().catch(() => ({}))) as { loggedIn?: boolean; detail?: string; error?: string };
    if (!resp.ok) return { error: data.error ?? `检查失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function startSauLogin(
  platform: string,
  target: { platform: string; account: string },
): Promise<{ ok?: boolean; detail?: string; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/sau/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; detail?: string; error?: string };
    if (!resp.ok) return { error: data.error ?? `登录失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function publishStudioVideo(
  platform: string,
  articleId: string,
  body: { targets: Array<{ platform: string; account: string }>; videoPath?: string; schedule?: string },
): Promise<{ records?: MediaPublishRecord[]; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/publish-video`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const data = (await resp.json().catch(() => ({}))) as {
      records?: MediaPublishRecord[];
      article?: MediaArticle;
      error?: string;
    };
    if (!resp.ok) return { error: data.error ?? `发布失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

/** 图文笔记矩阵发布（sau upload-note）。 */
export async function publishStudioNote(
  platform: string,
  articleId: string,
  body: { targets: Array<{ platform: string; account: string }>; schedule?: string },
): Promise<{ records?: MediaPublishRecord[]; article?: MediaArticle; error?: string }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/publish-note`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const data = (await resp.json().catch(() => ({}))) as {
      records?: MediaPublishRecord[];
      article?: MediaArticle;
      error?: string;
    };
    if (!resp.ok) return { error: data.error ?? `发布失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

// ---- 内置多 Profile 浏览器（风控安全发布） ----

export async function resolvePlatformBrowserUrl(platform: string): Promise<string | null> {
  try {
    const resp = await fetch(`${ROOT}/browser/urls`);
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => ({}))) as {
      urls?: Record<string, string | { label?: string; url?: string }>;
    };
    const entry = data.urls?.[platform];
    if (typeof entry === 'string') return entry;
    return entry?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * 打开平台后台。桌面端 = 应用内后台标签页(2026-07-09 用户拍板:与创作台
 * 并列切换,keep-alive 不重载);网页端落回 daemon 拉起的独立 Chrome 档案。
 * 两条路径共用同一 persist 分区档案,登录态互通。
 */
export async function openStudioBrowser(body: {
  platform: string;
  account: string;
  url?: string;
  /** 「一键存草稿」:面板打开后自动填稿(仅桌面端应用内面板路径生效)。 */
  draft?: import('../runtime/browser-draft').DraftPayload;
  /** handoff 桥 job id:带上后注入进度/终态回写 daemon(CLI 在等)。 */
  draftJobId?: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const platform = normalizeBrowserPlatform(body.platform);
  const account = body.account.trim() || 'main';
  if (isOpenDesignHostBrowserAvailable()) {
    const url = body.url ?? (await resolvePlatformBrowserUrl(platform));
    if (url != null) {
      openBrowserPane({
        platform,
        account,
        url,
        ...(body.draft ? { draft: body.draft } : {}),
        ...(body.draftJobId ? { draftJobId: body.draftJobId } : {}),
      });
      return { ok: true };
    }
  }
  try {
    const resp = await fetch(`${ROOT}/browser/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, account }),
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!resp.ok) return { error: data.error ?? `打开浏览器失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

/**
 * 弹出「独立窗口」形态的后台(老路径):后台面板工具条的双屏按钮、以及
 * 网页版降级卡片用。与应用内标签同档案,登录态互通。
 */
export async function openStudioBrowserWindow(body: {
  platform: string;
  account: string;
  url?: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const platform = normalizeBrowserPlatform(body.platform);
  const account = body.account.trim() || 'main';
  if (isOpenDesignHostBrowserAvailable()) {
    const url = body.url ?? (await resolvePlatformBrowserUrl(platform));
    if (url != null) {
      const platformLabel = BROWSER_PLATFORM_TITLES[platform] ?? platform;
      const opened = await openHostBrowserProfile({
        platform,
        account,
        title: `${platformLabel} · ${account}`,
        url,
      });
      if (opened.ok) return { ok: true };
    }
  }
  try {
    const resp = await fetch(`${ROOT}/browser/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, account }),
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!resp.ok) return { error: data.error ?? `打开浏览器失败 (${resp.status})` };
    return data;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

// ---- handoff 桥(CLI「od studio handoff」派发的注入 job) ----

/** 认领派发 job(多桌面窗口先到先得)。false = 别的窗口抢到了/job 没了。 */
export async function claimHandoffJob(jobId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/handoff/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 注入进度回写(fire-and-forget:回写失败不影响注入本身)。 */
export function reportHandoffProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/handoff/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => undefined);
}

/** 注入终态回写(done/error;fire-and-forget)。 */
export function completeHandoffJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/handoff/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

// ── 内置浏览器采集 job 回写(爆款雷达;桌面端标签里执行) ──
export async function claimCollectJob(jobId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/collect/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

export function reportCollectProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/collect/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => undefined);
}

export function postCollectResult(
  jobId: string,
  results: import('@open-design/contracts').StudioCollectPlatformResult[],
): void {
  void fetch(`${ROOT}/collect/${encodeURIComponent(jobId)}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results, ok: true }),
  }).catch(() => undefined);
}

export function completeCollectJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/collect/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

// ── 读评论桥（桌面端执行侧回写 daemon read-comments job）──
export async function claimCommentReadJob(jobId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/read-comments/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

export function reportCommentReadProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/read-comments/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => undefined);
}

export function postCommentReadResult(
  jobId: string,
  comments: import('@open-design/contracts').CommentNode[],
  needsLogin: boolean,
): void {
  void fetch(`${ROOT}/read-comments/${encodeURIComponent(jobId)}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comments, needsLogin, ok: true }),
  }).catch(() => undefined);
}

export function completeCommentReadJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/read-comments/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

// ── 互动执行桥(自动评论回复/楼中楼/私信;桌面端执行侧回写 daemon interaction job)──
export async function claimInteractionJob(jobId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/interaction/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

export function reportInteractionProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/interaction/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => undefined);
}

export function completeInteractionJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/interaction/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

// ── 登录态保活(W6):校验派发 + 状态一览 + 失效告警 ──
type LoginJob = import('@open-design/contracts').StudioLoginCheckJob;
type LoginRec = import('@open-design/contracts').LoginStatusRecord;
type Alert = import('@open-design/contracts').MediaAlert;

/** UI/心跳触发一次登录态校验(桌面端离线时 daemon 回 409,这里降级成 error)。 */
export async function requestLoginCheck(platform: string, account: string): Promise<LoginJob | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/login-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, account }),
    });
    if (!resp.ok) return { error: await errorMessage(resp, '发起登录校验失败') };
    return ((await resp.json()) as { job: LoginJob }).job;
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

export async function claimLoginCheckJob(jobId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/login-check/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

export function reportLoginCheckProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/login-check/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  }).catch(() => undefined);
}

/** 探测结果回写:daemon 据此落 media_login_status,从已登录翻转到失效时产告警。
 *  返回 promise:调用方 await 本次落库后再 complete(否则 complete 先到会把 job 置终态,
 *  job.loggedIn 被终态守卫丢弃 → CLI/UI 读到「未定」)。 */
export function postLoginCheckResult(jobId: string, loggedIn: boolean, detail: string): Promise<void> {
  return fetch(`${ROOT}/login-check/${encodeURIComponent(jobId)}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loggedIn, detail }),
  }).then(() => undefined).catch(() => undefined);
}

export function completeLoginCheckJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/login-check/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

/** 账号页:各 平台×账号 的最近登录态一览。 */
export async function fetchLoginStatus(platform?: string): Promise<LoginRec[]> {
  try {
    const q = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    const resp = await fetch(`${ROOT}/login-status${q}`);
    if (!resp.ok) return [];
    const d = (await resp.json()) as { items?: LoginRec[] };
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

export async function fetchMediaAlerts(includeDismissed = false): Promise<Alert[]> {
  try {
    const resp = await fetch(`${ROOT}/alerts${includeDismissed ? '?all=1' : ''}`);
    if (!resp.ok) return [];
    const d = (await resp.json()) as { items?: Alert[] };
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

export async function dismissMediaAlert(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/alerts/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── 状态监控面板(W7):多账号健康看板(登录态 + 今日名额 + 今日战果)──
export async function fetchMonitor(platform?: string): Promise<import('@open-design/contracts').MonitorResponse> {
  try {
    const q = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    const resp = await fetch(`${ROOT}/monitor${q}`);
    if (!resp.ok) return { items: [], dayStartMs: 0 };
    return (await resp.json()) as import('@open-design/contracts').MonitorResponse;
  } catch {
    return { items: [], dayStartMs: 0 };
  }
}

// ── 「我的笔记」抓取(互动回复的笔记选择器,免手动贴链接)──
type MyNotesJobT = import('@open-design/contracts').StudioMyNotesJob;
type NoteCardT = import('@open-design/contracts').StudioNoteCard;

export async function claimMyNotesJob(jobId: string): Promise<boolean> {
  try {
    const r = await fetch(`${ROOT}/my-notes/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
    return r.ok;
  } catch {
    return false;
  }
}
export function reportMyNotesProgress(jobId: string, message: string): void {
  void fetch(`${ROOT}/my-notes/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  }).catch(() => undefined);
}
// 返回 promise:调用方必须【await 本次 result 落库后再 complete】,否则两个 fire-and-forget
// fetch 竞态,complete 先到会把 job 置终态,随后的 setResult 撞终态守卫被丢弃 → notes 丢失。
export function postMyNotesResult(jobId: string, notes: NoteCardT[], needsLogin: boolean): Promise<void> {
  return fetch(`${ROOT}/my-notes/${encodeURIComponent(jobId)}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes, needsLogin, ok: true }),
  }).then(() => undefined).catch(() => undefined);
}
export function completeMyNotesJob(jobId: string, ok: boolean, detail: string): void {
  void fetch(`${ROOT}/my-notes/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, detail }),
  }).catch(() => undefined);
}

/** UI:抓某账号自己的已发笔记(派发桌面端探测 → 长轮询回结果)。桌面离线/超时返回 error。 */
export async function fetchMyNotes(
  platform: string,
  account: string | null,
): Promise<{ notes: NoteCardT[]; needsLogin?: boolean } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/my-notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, account }),
    });
    if (resp.status === 409) return { error: '桌面端未连接——抓「我的笔记」需要 social-auto 桌面应用在运行' };
    if (!resp.ok) return { error: await errorMessage(resp, '抓我的笔记失败') };
    const { job } = (await resp.json()) as { job: MyNotesJobT };
    const deadline = Date.now() + 150_000; // 前台化 + 两段 SPA 加载,给足时间
    let cursor = 0;
    while (Date.now() < deadline) {
      const w = await fetch(`${ROOT}/my-notes/${encodeURIComponent(job.id)}/wait?since=${cursor}&timeoutMs=20000`).catch(() => null);
      if (!w || !w.ok) break;
      const snap = (await w.json()) as { job: MyNotesJobT; cursor: number };
      cursor = snap.cursor ?? cursor;
      if (snap.job.status === 'done' || snap.job.status === 'error') {
        return { notes: snap.job.notes ?? [], ...(snap.job.needsLogin ? { needsLogin: true as const } : {}) };
      }
    }
    return { error: '抓取超时(桌面端可能没在跑)' };
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

// ── 互动运营 UI:匹配规则 CRUD + 自动回复(预览/真发) ──
type IRule = import('@open-design/contracts').InteractionRule;

export async function fetchInteractionRules(platform: string, account?: string | null): Promise<IRule[]> {
  try {
    const q = new URLSearchParams({ platform });
    if (account !== undefined) q.set('account', account ?? '');
    const resp = await fetch(`${ROOT}/interaction-rules?${q}`);
    if (!resp.ok) return [];
    const d = (await resp.json()) as { items?: IRule[] };
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

export async function addInteractionRule(
  body: import('@open-design/contracts').CreateInteractionRuleRequest,
): Promise<IRule | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/interaction-rules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: await errorMessage(resp, '加规则失败') };
    return ((await resp.json()) as { rule: IRule }).rule;
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

export async function updateInteractionRuleReq(
  id: string, patch: import('@open-design/contracts').UpdateInteractionRuleRequest,
): Promise<IRule | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/interaction-rules/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!resp.ok) return { error: await errorMessage(resp, '改规则失败') };
    return ((await resp.json()) as { rule: IRule }).rule;
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

export async function removeInteractionRule(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ROOT}/interaction-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function runAutoReply(
  body: import('@open-design/contracts').AutoReplyRequest,
): Promise<import('@open-design/contracts').AutoReplyResponse | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/auto-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: await errorMessage(resp, '自动回复失败') };
    return (await resp.json()) as import('@open-design/contracts').AutoReplyResponse;
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

// ── 统一创作台「去创作」自动带入原素材（原文/原图/原视频直链）──
// daemon /fetch-source 未接入时优雅降级(返回 error,创作台照常创作,不自动拉取)。
export async function fetchSourceMaterial(url: string): Promise<{ text: string; images: string[]; title: string; mediaUrl: string; referer: string } | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/fetch-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = (await resp.json().catch(() => ({}))) as { text?: string; images?: string[]; title?: string; mediaUrl?: string; referer?: string; error?: string };
    if (!resp.ok) return { error: d.error ?? `取原素材失败(${resp.status})` };
    return { text: d.text ?? '', images: Array.isArray(d.images) ? d.images : [], title: d.title ?? '', mediaUrl: d.mediaUrl ?? '', referer: d.referer ?? url };
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

/** 由选题来源 URL 判定原平台（创作台选形态/数据源用）。纯客户端正则,无依赖。 */
export function topicOriginPlatform(url?: string | null): string {
  const u = (url || '').toLowerCase();
  if (!u) return 'any';
  if (/xiaohongshu\.com|xhslink\.com/.test(u)) return 'xiaohongshu';
  if (/douyin\.com|iesdouyin\.com/.test(u)) return 'douyin';
  if (/kuaishou\.com|chenzhongtech\.com/.test(u)) return 'kuaishou';
  if (/bilibili\.com|b23\.tv/.test(u)) return 'bilibili';
  if (/channels\.weixin\.qq\.com/.test(u)) return 'channels';
  return 'other';
}

/** 图片资产的本机绝对路径(「一键存草稿」CDP 注入用)。 */
export async function fetchStudioAssetPaths(
  platform: string,
  articleId: string,
): Promise<Array<{ name: string; absPath: string; url: string }>> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/asset-paths`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json().catch(() => ({}))) as { files?: Array<{ name: string; absPath: string; url: string }> };
    return data.files ?? [];
  } catch {
    return [];
  }
}

/** TikHub 平台分流选题(抖音↔抖音接口/小红书↔小红书/快手↔快手)。 */
export async function fetchTikhubFeed(
  platform: string,
  body: import('@open-design/contracts').TikhubFeedRequest,
): Promise<import('@open-design/contracts').TikhubFeedResponse | { error: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(platform)}/topics/tikhub-feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) return { error: String(data.error ?? `TikHub 选题失败 (${resp.status})`) };
    return data as unknown as import('@open-design/contracts').TikhubFeedResponse;
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function revealStudioAssets(platform: string, articleId: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/reveal-assets`,
      { method: 'POST' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function markStudioPublished(
  platform: string,
  articleId: string,
  targetLabel: string,
): Promise<{ record?: MediaPublishRecord; article?: MediaArticle }> {
  try {
    const resp = await fetch(
      `${ROOT}/${encodeURIComponent(platform)}/articles/${encodeURIComponent(articleId)}/mark-published`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLabel }),
      },
    );
    if (!resp.ok) return {};
    return (await resp.json()) as { record?: MediaPublishRecord; article?: MediaArticle };
  } catch {
    return {};
  }
}

export { errorMessage as studioErrorMessage };
