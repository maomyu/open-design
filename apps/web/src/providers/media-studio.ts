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
}): Promise<{ ok?: boolean; error?: string }> {
  const platform = normalizeBrowserPlatform(body.platform);
  const account = body.account.trim() || 'main';
  if (isOpenDesignHostBrowserAvailable()) {
    const url = body.url ?? (await resolvePlatformBrowserUrl(platform));
    if (url != null) {
      openBrowserPane({ platform, account, url, ...(body.draft ? { draft: body.draft } : {}) });
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
