// Media Studio（媒体创作台）HTTP routes — spec: specs/current/media-studio.md
//
// The four studio navigations (选题/写作/排版/发布) all speak to these
// endpoints. Rendering and publishing are deterministic product code; the
// stateless /render endpoint additionally powers the live preview and the
// standalone 排版 mode (paste any markdown, no article required).
//
//   GET/POST                /api/media-studio/:platform/articles
//   GET/PATCH/DELETE        /api/media-studio/:platform/articles/:id
//   POST                    /api/media-studio/:platform/articles/:id/render
//   POST                    /api/media-studio/:platform/articles/:id/publish
//   GET                     /api/media-studio/:platform/articles/:id/publishes
//   POST                    /api/media-studio/render
//   GET/POST/PATCH/DELETE   /api/media-studio/:platform/topics[/:id]
//   GET/POST/DELETE         /api/media-studio/:platform/snippets[/:id]
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type {
  CreateMediaArticleRequest,
  CreateMediaSnippetRequest,
  CreateMediaTopicRequest,
  GenerateArticleImageRequest,
  CreateStudioHandoffRequest,
  MediaRenderRequest,
  StudioAiTaskRequest,
  StudioHandoffCompleteRequest,
  TopicFeedSearchRequest,
  TikhubFeedRequest,
  TikhubFeedResponse,
  UpdateMediaArticleRequest,
  UpdateMediaTopicRequest,
} from '@open-design/contracts';
import { MEDIA_PLATFORMS } from '@open-design/contracts';
import type { PathDeps, RouteDeps } from './server-context.js';
import { readAppConfig, platformAccountsForPlatform } from './app-config.js';
import { resolveProviderConfig } from './media-config.js';
import { getProject, insertConversation, insertProject } from './db.js';
import {
  dajialaAccountRank,
  dajialaArticleDetail,
  dajialaComments,
  dajialaHotSearch,
  dajialaKwSearch,
  dajialaPeersLatest,
  dajialaRadar,
  dajialaReadZanPro,
  dajialaSugWords,
  dajialaWebSearch,
} from './media-studio/dajiala.js';
import { TikhubError, tikhubTopicFeed } from './media-studio/tikhub.js';
import { generateGeminiImageFallback, generateQwenImage, QwenImageError } from './media-studio/qwen-image.js';
import { generateVolcImage, VolcImageError } from './media-studio/volc-image.js';
import { missingKeyError, resolveStudioKeys } from './media-studio/step-keys.js';
import { composeStudioAiTask } from './media-studio/ai-tasks.js';
import { lintContent } from './media-studio/lint.js';
import { BrowserError, openProfileBrowser, PLATFORM_PUBLISH_URLS, revealInFinder } from './media-studio/browser.js';
import { createHandoffBus, HANDOFF_PLATFORMS, HandoffError, isHandoffPlatform } from './media-studio/handoff-jobs.js';
import { createCollectBus, COLLECT_PLATFORMS, CollectError, isCollectPlatform } from './media-studio/collect-jobs.js';
import { createInteractionBus, InteractionError } from './media-studio/interaction-jobs.js';
import { createCommentReadBus, CommentReadError } from './media-studio/comment-read-jobs.js';
import { createLoginCheckBus, LoginCheckError } from './media-studio/login-check-jobs.js';
import { createMyNotesBus, MyNotesError } from './media-studio/my-notes-jobs.js';
import { DEFAULT_INTERACTION_POLICY } from './media-studio/interaction-quota.js';
import { matchInteractionRule } from './media-studio/interaction-rules.js';
import type {
  AutoReplyPlanItem,
  AutoReplyRequest,
  AutoReplyResponse,
  CommentNode,
  CreateStudioCollectRequest,
  CreateStudioInteractionRequest,
  CreateStudioCommentReadRequest,
  InteractionAction,
  MonitorAccount,
  MonitorResponse,
  StudioCollectPlatform,
  StudioCollectResultRequest,
  StudioCommentReadResultRequest,
} from '@open-design/contracts';
import { sauCheck, sauLogin, sauUploadNote, sauUploadVideo, SauError } from './media-studio/sau.js';
import { scriptToSpeech, synthesizeVoice, TtsError } from './media-studio/volc-tts.js';
import {
  createArticle,
  createKnowledge,
  createSnippet,
  createTopic,
  createVersion,
  deleteArticle,
  deleteKnowledge,
  deleteSnippet,
  deleteTopic,
  getArticle,
  getKnowledge,
  getVersion,
  listArticles,
  listKnowledge,
  listPublishes,
  listSnippets,
  listTopics,
  listVersions,
  markArticlePublished,
  recordPublish,
  saveArticleRender,
  updateArticle,
  updateTopic,
  claimInteractionSlot,
  recordInteraction,
  listInteractions,
  peekInteractionQuota,
  listInteractionRules,
  getInteractionRule,
  createInteractionRule,
  updateInteractionRule,
  deleteInteractionRule,
  setLoginStatus,
  listLoginStatus,
  getLoginStatus,
  createAlert,
  listAlerts,
  dismissAlert,
} from './media-studio/store.js';
import { fontSizesFromExtra, renderWechatHtml, WECHAT_SKINS } from './media-studio/wechat-render.js';
import { publishWechatDraft, WechatPublishError } from './media-studio/wechat-publish.js';

export interface RegisterMediaStudioRoutesDeps extends RouteDeps<'db'> {
  paths: Pick<PathDeps, 'RUNTIME_DATA_DIR' | 'PROJECT_ROOT'>;
}

/** 创作台的 AI 任务都挂在这个隐藏项目下，按任务开会话，完整过程可回看。 */
const STUDIO_PROJECT_ID = 'media-studio-hub';

/** Web-servable asset URL prefix; the publisher maps it back to disk files. */
export const STUDIO_ASSET_URL_PREFIX = '/api/media-studio/assets/';

function bad(res: any, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function registerMediaStudioRoutes(app: Express, deps: RegisterMediaStudioRoutesDeps): void {
  const { db, paths } = deps;

  // ---- stateless render（实时预览 / 自由排版） ----
  app.post('/api/media-studio/render', (req, res) => {
    try {
      const body = (req.body ?? {}) as MediaRenderRequest;
      const result = renderWechatHtml(body);
      res.json({ html: result.html, skin: result.skin, notes: result.notes });
    } catch (err) {
      bad(res, 500, String(err instanceof Error ? err.message : err));
    }
  });

  app.get('/api/media-studio/:platform/skins', (_req, res) => {
    res.json({ skins: WECHAT_SKINS.map((s) => ({ id: s.id, name: s.name, color: s.titleColor })) });
  });

  // ---- articles ----
  app.get('/api/media-studio/:platform/articles', (req, res) => {
    res.json({ articles: listArticles(db, req.params.platform) });
  });

  app.post('/api/media-studio/:platform/articles', (req, res) => {
    try {
      const body = (req.body ?? {}) as CreateMediaArticleRequest;
      const article = createArticle(db, req.params.platform, body);
      res.json({ article });
    } catch (err) {
      bad(res, 400, String(err instanceof Error ? err.message : err));
    }
  });

  app.get('/api/media-studio/:platform/articles/:id', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    res.json({ article });
  });

  app.patch('/api/media-studio/:platform/articles/:id', (req, res) => {
    try {
      const article = updateArticle(db, req.params.id, (req.body ?? {}) as UpdateMediaArticleRequest);
      if (!article) return bad(res, 404, 'article not found');
      res.json({ article });
    } catch (err) {
      bad(res, 400, String(err instanceof Error ? err.message : err));
    }
  });

  app.delete('/api/media-studio/:platform/articles/:id', (req, res) => {
    if (!deleteArticle(db, req.params.id)) return bad(res, 404, 'article not found');
    res.json({ ok: true });
  });

  // Render AND persist（排版导航「保存排版」）.
  app.post('/api/media-studio/:platform/articles/:id/render', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const skin = typeof (req.body as any)?.skin === 'string' && (req.body as any).skin
      ? String((req.body as any).skin)
      : article.skin;
    if (skin !== article.skin) updateArticle(db, article.id, { skin });
    const result = renderWechatHtml({
      headerMd: article.headerMd,
      bodyMd: article.bodyMd,
      footerMd: article.footerMd,
      skin,
      ...fontSizesFromExtra(article.extra),
    });
    const updated = saveArticleRender(db, article.id, result.html, result.skin);
    res.json({ html: result.html, skin: result.skin, notes: result.notes, article: updated });
  });

  // Publish to the platform draft box（只发草稿箱）.
  app.post('/api/media-studio/:platform/articles/:id/publish', async (req, res) => {
    const platform = req.params.platform;
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const accountId = typeof (req.body as any)?.accountId === 'string' ? String((req.body as any).accountId) : '';

    const fail = (step: string, message: string, accountName = '') => {
      const record = recordPublish(db, {
        articleId: article.id,
        platform,
        accountId: accountId || null,
        accountName,
        status: 'error',
        draftMediaId: null,
        failedStep: step,
        error: message,
      });
      res.status(422).json({ error: message, record });
    };

    if (platform !== 'wechat-mp') return fail('account', `平台 ${platform} 的发布器尚未实现`);
    if (!accountId) return fail('account', '缺少 accountId——先在「发布」里选择公众号账号');

    let accountName = '';
    try {
      const prefs = await readAppConfig(paths.RUNTIME_DATA_DIR);
      const accounts = platformAccountsForPlatform(prefs, platform);
      const account = accounts.find((a) => a.id === accountId) ?? null;
      if (!account) return fail('account', '账号不存在——去「账号」页确认该公众号账号还在');
      accountName = account.name;
      const creds = account.credentials ?? {};
      const appid = String(creds.WECHAT_APPID ?? '').trim();
      const secret = String(creds.WECHAT_SECRET ?? '').trim();
      const author = String(creds.WECHAT_AUTHOR ?? '').trim();
      if (!appid || !secret) {
        return fail('account', `账号「${account.name}」缺少 ${!appid ? 'WECHAT_APPID' : 'WECHAT_SECRET'}——去「账号」页给它补上`, account.name);
      }

      const output = await publishWechatDraft({
        article,
        credentials: { appid, secret, author },
        // Studio-generated assets referenced as /api/media-studio/assets/...
        // upload straight from disk.
        resolveAssetPath: (src) => {
          if (!src.startsWith(STUDIO_ASSET_URL_PREFIX)) return null;
          const rest = src.slice(STUDIO_ASSET_URL_PREFIX.length).split('/');
          if (rest.length !== 2) return null;
          const articleId = decodeURIComponent(rest[0] ?? '');
          const file = decodeURIComponent(rest[1] ?? '');
          if (!articleId || !file || file.includes('..') || file.includes(path.sep)) return null;
          return path.join(assetsDirFor(articleId), file);
        },
      });
      saveArticleRender(db, article.id, output.contentHtml, article.skin);
      markArticlePublished(db, article.id);
      const record = recordPublish(db, {
        articleId: article.id,
        platform,
        accountId,
        accountName,
        status: 'ok',
        draftMediaId: output.draftMediaId,
        failedStep: null,
        error: null,
      });
      res.json({ record, article: getArticle(db, article.id) });
    } catch (err) {
      const step = err instanceof WechatPublishError ? err.step : 'draft';
      fail(step, err instanceof Error ? err.message : String(err), accountName);
    }
  });

  // ---- note: 图文笔记矩阵发布（图集来自 extra.noteImages 资产 URL 列表） ----
  app.post('/api/media-studio/:platform/articles/:id/publish-note', async (req, res) => {
    const platform = req.params.platform;
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const body = (req.body ?? {}) as { targets?: Array<{ platform?: string; account?: string }>; schedule?: string };
    const targets = (body.targets ?? []).filter((t) => t?.platform && t?.account) as Array<{ platform: string; account: string }>;
    if (targets.length === 0) return bad(res, 400, '至少选择一个 平台×账号 发布目标');
    const noteImages = Array.isArray(article.extra.noteImages)
      ? (article.extra.noteImages as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (noteImages.length === 0) return bad(res, 422, '图集为空——先在「图集」里生成或上传至少 1 张图');
    // 资产 URL → 本地文件（sau 需要本地路径）
    const localImages: string[] = [];
    for (const url of noteImages) {
      if (!url.startsWith(STUDIO_ASSET_URL_PREFIX)) return bad(res, 422, `图集里有非本地资产图片:${url.slice(0, 60)}`);
      const rest = url.slice(STUDIO_ASSET_URL_PREFIX.length).split('/');
      if (rest.length !== 2) return bad(res, 422, '图集资产 URL 形状不对');
      localImages.push(path.join(assetsDirFor(decodeURIComponent(rest[0] ?? '')), decodeURIComponent(rest[1] ?? '')));
    }
    const title = article.title.trim();
    if (!title) return bad(res, 422, '标题为空——先在「文案」里定标题');
    const note = article.bodyMd.trim();
    if (!note) return bad(res, 422, '正文为空——先在「文案」里写正文');
    const tags = String(article.extra.tags ?? '').trim();
    const records = [];
    for (const target of targets) {
      let record;
      try {
        const result = await sauUploadNote({
          platform: target.platform,
          account: target.account,
          images: localImages,
          title,
          note,
          ...(tags ? { tags } : {}),
          ...(body.schedule ? { schedule: body.schedule } : {}),
        });
        record = recordPublish(db, {
          articleId: article.id,
          platform,
          accountId: null,
          accountName: `${target.platform}/${target.account}`,
          status: result.ok ? 'ok' : 'error',
          draftMediaId: null,
          failedStep: result.ok ? null : 'upload',
          error: result.ok ? null : result.detail,
        });
      } catch (err) {
        record = recordPublish(db, {
          articleId: article.id,
          platform,
          accountId: null,
          accountName: `${target.platform}/${target.account}`,
          status: 'error',
          draftMediaId: null,
          failedStep: 'upload',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      records.push(record);
    }
    if (records.some((r) => r.status === 'ok')) markArticlePublished(db, article.id);
    res.json({ records, article: getArticle(db, article.id) });
  });

  app.get('/api/media-studio/:platform/articles/:id/publishes', (req, res) => {
    res.json({ publishes: listPublishes(db, req.params.id) });
  });

  // ---- topic data feeds（大家来直调；价格永不入响应，只报条数） ----
  const feedHandler = (
    run: (
      key: string,
      body: TopicFeedSearchRequest,
    ) => Promise<{ items: unknown[]; sources: string[]; words?: string[] }>,
  ) => {
    return async (req: any, res: any) => {
      try {
        const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
        const apiKey = (keys.DAJIALA_API_KEY ?? '').trim();
        if (!apiKey) return bad(res, 422, missingKeyError('DAJIALA_API_KEY'));
        const body = (req.body ?? {}) as TopicFeedSearchRequest;
        const result = await run(apiKey, body);
        res.json(result);
      } catch (err) {
        bad(res, 502, err instanceof Error ? err.message : String(err));
      }
    };
  };

  app.post('/api/media-studio/:platform/topics/hot-search', feedHandler(async (key, body) => ({
    items: await dajialaHotSearch(key, {
      keyword: body.keyword ?? '',
      days: body.days ?? 7,
      page: body.page ?? 1,
    }),
    sources: ['trending'],
  })));

  app.post('/api/media-studio/:platform/topics/web-search', feedHandler(async (key, body) => {
    if (!body.keyword?.trim()) throw new Error('搜一搜需要关键词');
    return {
      items: await dajialaWebSearch(key, { keyword: body.keyword.trim(), sort: body.sort ?? 'hottest' }),
      sources: ['realtime'],
    };
  }));

  app.post('/api/media-studio/:platform/topics/radar', feedHandler(async (key, body) => {
    if (!body.keyword?.trim()) throw new Error('雷达需要关键词');
    return dajialaRadar(key, { keyword: body.keyword.trim(), days: body.days ?? 7 });
  }));

  // 2026-07-07 接口调研落地：全库搜索（带真实阅读数）/ 需求词 / 对标动态。
  app.post('/api/media-studio/:platform/topics/kw-search', feedHandler(async (key, body) => {
    if (!body.keyword?.trim()) throw new Error('全库搜索需要关键词');
    return {
      items: await dajialaKwSearch(key, { keyword: body.keyword.trim(), page: body.page ?? 1 }),
      sources: ['kwdb'],
    };
  }));

  app.post('/api/media-studio/:platform/topics/sug', feedHandler(async (key, body) => {
    if (!body.keyword?.trim()) throw new Error('需求词需要一个起点词');
    return {
      items: [],
      sources: ['sug'],
      words: await dajialaSugWords(key, body.keyword.trim()),
    };
  }));

  app.post('/api/media-studio/:platform/topics/peers', feedHandler(async (key, body) => {
    const accounts = Array.isArray(body.accounts)
      ? body.accounts.map((a) => String(a).trim()).filter(Boolean)
      : [];
    if (accounts.length === 0) throw new Error('对标动态需要至少一个账号名');
    return {
      items: await dajialaPeersLatest(key, accounts),
      sources: ['peer'],
    };
  }));

  // ---- TikHub 选题源(2026-07-09 用户拍板:短视频选题弃大家来,按目标
  // 平台分流——抖音选题走抖音接口、小红书走小红书、快手走快手)。 ----
  app.post('/api/media-studio/:platform/topics/tikhub-feed', async (req, res) => {
    try {
      const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
      const apiKey = (keys.TIKHUB_API_KEY ?? '').trim();
      if (!apiKey) return bad(res, 422, missingKeyError('TIKHUB_API_KEY'));
      const body = (req.body ?? {}) as TikhubFeedRequest;
      const target = body.target;
      const okTargets = ['douyin', 'xiaohongshu', 'kuaishou', 'zhihu', 'weibo'];
      if (!okTargets.includes(target)) {
        return bad(res, 400, `target must be one of ${okTargets.join(', ')}`);
      }
      const mode = body.mode === 'search' ? 'search' : 'hot';
      const items = await tikhubTopicFeed(apiKey, target, mode, body.keyword);
      res.json({ items, target, mode } satisfies TikhubFeedResponse);
    } catch (err) {
      bad(res, err instanceof TikhubError ? 422 : 502, err instanceof Error ? err.message : String(err));
    }
  });

  // 选题深挖三件套：六维互动验证 / 评论区 / 类目榜（均为大家来直调）。
  const withDajialaKey = (
    run: (key: string, body: Record<string, unknown>) => Promise<unknown>,
  ) => {
    return async (req: any, res: any) => {
      try {
        const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
        const apiKey = (keys.DAJIALA_API_KEY ?? '').trim();
        if (!apiKey) return bad(res, 422, missingKeyError('DAJIALA_API_KEY'));
        res.json(await run(apiKey, (req.body ?? {}) as Record<string, unknown>));
      } catch (err) {
        bad(res, 502, err instanceof Error ? err.message : String(err));
      }
    };
  };

  app.post('/api/media-studio/:platform/topics/verify', withDajialaKey(async (key, body) => {
    const url = String(body.url ?? '').trim();
    if (!url) throw new Error('验证需要文章链接');
    return { engagement: await dajialaReadZanPro(key, url) };
  }));

  app.post('/api/media-studio/:platform/topics/comments', withDajialaKey(async (key, body) => {
    const url = String(body.url ?? '').trim();
    if (!url) throw new Error('看评论需要文章链接');
    return { comments: await dajialaComments(key, url) };
  }));

  app.post('/api/media-studio/:platform/topics/account-rank', withDajialaKey(async (key, body) => {
    return {
      accounts: await dajialaAccountRank(key, {
        ...(body.type != null ? { type: Number(body.type) } : {}),
        ...(body.page != null ? { page: Number(body.page) } : {}),
      }),
    };
  }));

  // ---- article images（千问生图直调 + 标注替换回写） ----
  // path.resolve（而不是 join）：RUNTIME_DATA_DIR 可能是相对路径，
  // res.sendFile 要求绝对路径，相对路径会让资产 GET 一律 404。
  const assetsDirFor = (articleId: string) =>
    path.resolve(paths.RUNTIME_DATA_DIR, 'media-studio', articleId);

  app.post('/api/media-studio/:platform/articles/:id/images', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const body = (req.body ?? {}) as GenerateArticleImageRequest;
    const description = String(body.description ?? '').trim();
    if (!description) return bad(res, 400, '缺少图片描述');
    try {
      const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
      const model = typeof body.model === 'string' && body.model ? body.model : 'qwen';
      const apiKey = (keys.QWEN_API_KEY ?? keys.DASHSCOPE_API_KEY ?? '').trim();
      if (model === 'qwen' && !apiKey) return bad(res, 422, missingKeyError('QWEN_API_KEY'));
      if (model === 'gemini' && !(keys.GEMINI_API_KEY ?? '').trim()) {
        return bad(res, 422, missingKeyError('GEMINI_API_KEY'));
      }
      const dir = assetsDirFor(article.id);
      await mkdir(dir, { recursive: true });
      const marker = typeof body.marker === 'string' && body.marker ? body.marker : null;
      // 时间戳后加随机段：双候选并行请求会在同一毫秒落盘，纯 Date.now()
      // 会同名互相覆盖（一张图丢失 + 前端候选 key 重复）。
      const baseName = `img-${(marker ?? 'x').replace(/[^\w-]/g, '')}-${Date.now()}-${randomUUID().slice(0, 6)}`;
      // 参考图若是我们自己的资产 URL（本机上传的图），映射回磁盘文件。
      let referenceImage = typeof body.referenceImage === 'string' ? body.referenceImage.trim() : '';
      if (referenceImage.startsWith(STUDIO_ASSET_URL_PREFIX)) {
        const rest = referenceImage.slice(STUDIO_ASSET_URL_PREFIX.length).split('/');
        if (rest.length === 2) {
          referenceImage = path.join(assetsDirFor(decodeURIComponent(rest[0] ?? '')), decodeURIComponent(rest[1] ?? ''));
        }
      }
      let finalPath: string;
      let note: string | null = null;
      if (model === 'volc' || model.startsWith('volc:')) {
        // 火山方舟 Seedream：独立钥匙（ARK_API_KEY），审查体系与阿里不同，
        // 涉军等题材常常能直出。版本优先级：下拉里选的具体版本（volc:<id>）
        // > 设置里的自定义模型 > 默认最新（5.0）。
        const arkKey = (keys.ARK_API_KEY ?? keys.VOLC_ARK_API_KEY ?? '').trim();
        if (!arkKey) {
          throw new VolcImageError(
            '未配置火山方舟 API Key——去「设置 → 媒体生成 → Volcengine Ark」填上（ark.cn-beijing.volces.com 控制台创建，注意开通 Seedream 模型权限）',
          );
        }
        const requestedModel = model.includes(':') ? model.slice(model.indexOf(':') + 1).trim() : '';
        const volcCfg = await resolveProviderConfig(paths.PROJECT_ROOT, 'volcengine').catch(() => ({} as { model?: string }));
        const volcModel = requestedModel || volcCfg.model || '';
        finalPath = await generateVolcImage({
          prompt: description,
          outFile: path.join(dir, baseName),
          ...(body.style ? { style: body.style } : {}),
          ...(body.ratio ? { ratio: body.ratio } : {}),
          ...(volcModel ? { model: volcModel } : {}),
          apiKey: arkKey,
        });
      } else if (model === 'gemini') {
        // 用户显式选 Gemini：直接走 Gemini（不经过千问）。
        finalPath = await generateGeminiImageFallback({
          prompt: description,
          outFile: path.join(dir, `${baseName}.png`),
          ...(body.ratio ? { ratio: body.ratio } : {}),
          env: keys,
        });
      } else {
        try {
          const result = await generateQwenImage({
            prompt: description,
            outFile: path.join(dir, baseName),
            ...(body.style ? { style: body.style } : {}),
            ...(body.ratio ? { ratio: body.ratio } : {}),
            ...(referenceImage ? { referenceImage } : {}),
            apiKey,
          });
          finalPath = result.file;
          if (result.neutralized) {
            note = '原描述被内容安全拦截，已自动中性化敏感元素后生成（画面主体保留、军队/制服等词替换为中性表达）';
          }
        } catch (err) {
          // 千问失败自动 Gemini 兜底（有 key 才试）——插件流水线的既有约定。
          const geminiKey = (keys.GEMINI_API_KEY ?? '').trim();
          if (!(err instanceof QwenImageError) || !geminiKey) throw err;
          finalPath = await generateGeminiImageFallback({
            prompt: description,
            outFile: path.join(dir, `${baseName}.png`),
            ...(body.ratio ? { ratio: body.ratio } : {}),
            env: keys,
          });
          note = '千问被拦截/失败，本图由 Gemini 备用模型生成';
        }
      }
      const file = path.basename(finalPath);
      const url = `${STUDIO_ASSET_URL_PREFIX}${encodeURIComponent(article.id)}/${encodeURIComponent(file)}`;

      const isCover = body.asCover === true || (marker ?? '').toUpperCase() === 'COVER';
      const patch: UpdateMediaArticleRequest = {};
      if (marker && !isCover) {
        // Replace the authoring placeholder with real image markdown so the
        // live preview (and publish) pick it up immediately.
        const markerRe = new RegExp(`<!--\\s*IMAGE_${marker}\\s*:[\\s\\S]*?-->`);
        patch.bodyMd = markerRe.test(article.bodyMd)
          ? article.bodyMd.replace(markerRe, `![${description.slice(0, 40)}](${url})`)
          : `${article.bodyMd}\n\n![${description.slice(0, 40)}](${url})`;
      }
      if (isCover) patch.coverSource = url;
      const updated = Object.keys(patch).length > 0 ? updateArticle(db, article.id, patch) : article;
      res.json({ url, file, article: updated, ...(note ? { note } : {}) });
    } catch (err) {
      bad(res, 502, err instanceof Error ? err.message : String(err));
    }
  });

  // Serve generated assets (preview <img> and cover thumbnails). Manual
  // readFile instead of res.sendFile: express send() 404s on this repo's
  // non-ASCII absolute path even though the file exists.
  app.get('/api/media-studio/assets/:articleId/:file', async (req, res) => {
    const dir = assetsDirFor(String(req.params.articleId));
    const file = path.normalize(String(req.params.file));
    if (file.includes('..') || file.includes(path.sep) || file.startsWith('.')) {
      return bad(res, 400, 'bad file name');
    }
    try {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(path.join(dir, file));
      res.setHeader(
        'Content-Type',
        /\.png$/i.test(file) ? 'image/png'
          : /\.webp$/i.test(file) ? 'image/webp'
            : /\.wav$/i.test(file) ? 'audio/wav'
              : /\.mp3$/i.test(file) ? 'audio/mpeg'
                : /\.mp4$/i.test(file) ? 'video/mp4'
                  : 'image/jpeg',
      );
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    } catch {
      bad(res, 404, 'asset not found');
    }
  });

  // ---- 版本历史（AI 覆盖前自动快照,可回退） ----
  app.get('/api/media-studio/:platform/articles/:id/versions', (req, res) => {
    res.json({ versions: listVersions(db, req.params.id) });
  });

  app.post('/api/media-studio/:platform/articles/:id/versions', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const label = String((req.body as any)?.label ?? '手动存档');
    res.json({ version: createVersion(db, article, label) });
  });

  app.post('/api/media-studio/:platform/articles/:id/versions/:vid/restore', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const version = getVersion(db, req.params.vid);
    if (!version || version.articleId !== article.id) return bad(res, 404, 'version not found');
    // 回退本身也先快照，避免「回退错了回不来」。
    createVersion(db, article, '回退前自动存档');
    const updated = updateArticle(db, article.id, {
      title: version.title,
      digest: version.digest,
      headerMd: version.headerMd,
      bodyMd: version.bodyMd,
      footerMd: version.footerMd,
    });
    res.json({ article: updated });
  });

  // ---- 本机图片上传（封面/参考图/正文插图,base64 JSON） ----
  app.post('/api/media-studio/:platform/articles/:id/upload-asset', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    try {
      const body = (req.body ?? {}) as { filename?: string; dataBase64?: string };
      const raw = String(body.dataBase64 ?? '');
      if (!raw) return bad(res, 400, '缺少文件数据');
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 0) return bad(res, 400, '文件数据无效');
      if (buf.length > 20 * 1024 * 1024) return bad(res, 413, '文件超过 20MB');
      const ext = (path.extname(String(body.filename ?? '')) || '.jpg').toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        return bad(res, 400, '只支持 png/jpg/webp/gif 图片');
      }
      const dir = assetsDirFor(article.id);
      await mkdir(dir, { recursive: true });
      const file = `up-${Date.now()}${ext}`;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(dir, file), buf);
      const url = `${STUDIO_ASSET_URL_PREFIX}${encodeURIComponent(article.id)}/${encodeURIComponent(file)}`;
      res.json({ url, file });
    } catch (err) {
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 原文抓取（素材简报的原料;research AI 任务也走这里） ----
  app.post('/api/media-studio/:platform/article-detail', async (req, res) => {
    try {
      const url = String((req.body as any)?.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) return bad(res, 400, '需要 http(s) 原文链接');
      const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
      const apiKey = (keys.DAJIALA_API_KEY ?? '').trim();
      if (!apiKey) return bad(res, 422, missingKeyError('DAJIALA_API_KEY'));
      res.json(await dajialaArticleDetail(apiKey, url));
    } catch (err) {
      bad(res, 502, err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 内置多 Profile 浏览器（风控安全发布的核心：真实浏览器手动发） ----
  app.post('/api/media-studio/browser/open', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { platform?: string; account?: string; url?: string };
      const platform = String(body.platform ?? '').trim();
      const account = String(body.account ?? '').trim() || 'main';
      if (!platform) return bad(res, 400, '缺少 platform');
      const result = await openProfileBrowser({
        root: paths.RUNTIME_DATA_DIR,
        platform,
        account,
        ...(body.url ? { url: body.url } : {}),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      bad(res, err instanceof BrowserError ? 422 : 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/media-studio/browser/urls', (_req, res) => {
    res.json({ urls: PLATFORM_PUBLISH_URLS });
  });

  // ---- 浏览器注入发布派发桥（CLI「od studio handoff」→ 桌面端执行） ----
  // 注入引擎在桌面端 webview 里(登录分区 daemon 够不着),这里只做派发与
  // 状态回传:create 建 job + SSE 广播,web 认领执行并回写进度/终态,CLI
  // wait 长轮询取增量。详见 media-studio/handoff-jobs.ts 顶部注释。
  const handoffBus = createHandoffBus();

  app.post('/api/media-studio/handoff', (req, res) => {
    const body = (req.body ?? {}) as CreateStudioHandoffRequest;
    if (!isHandoffPlatform(body.platform)) {
      return bad(res, 400, `platform 必须是 ${HANDOFF_PLATFORMS.join('|')}`);
    }
    const articleId = String(body.articleId ?? '').trim();
    if (!articleId) return bad(res, 400, '缺少 articleId');
    const article = getArticle(db, articleId);
    if (!article) return bad(res, 404, 'article not found');
    try {
      const job = handoffBus.create({
        platform: body.platform,
        articleId,
        articlePlatform: article.platform,
        ...(typeof body.account === 'string' && body.account.trim()
          ? { account: body.account.trim() }
          : {}),
        autoPublish: body.autoPublish === true,
      });
      res.json({ job });
    } catch (err) {
      if (err instanceof HandoffError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // 桌面端 web 的订阅口:job 一个一个以 `job` 事件推下来(连上先补发 pending)。
  app.get('/api/media-studio/handoff/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = handoffBus.subscribe((job) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    });
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post('/api/media-studio/handoff/:id/claim', (req, res) => {
    const job = handoffBus.claim(req.params.id);
    if (!job) {
      const existing = handoffBus.get(req.params.id);
      if (!existing) return bad(res, 404, 'job not found');
      return bad(res, 409, `job 已被认领(${existing.status})`);
    }
    res.json({ job });
  });

  app.post('/api/media-studio/handoff/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = handoffBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/handoff/:id/complete', (req, res) => {
    const body = (req.body ?? {}) as StudioHandoffCompleteRequest;
    const job = handoffBus.complete(req.params.id, body.ok === true, String(body.detail ?? ''));
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/handoff/:id', (req, res) => {
    const job = handoffBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  // CLI 的长轮询口:?since=N 取进度增量;终态/有增量立即返回,否则挂到
  // timeoutMs(上限 25s,样式对齐 /api/media/tasks/:id/wait)。
  app.get('/api/media-studio/handoff/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await handoffBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // ---- 内置浏览器采集派发桥（爆款雷达 → 桌面端应用内标签执行，不弹独立窗口）----
  // 采集跑在桌面端 webview 标签里（登录态在浏览器分区，daemon 够不着）。引擎/CLI
  // create 建 job + SSE 广播，web 认领后在应用内标签开搜索页抓卡片、回写结果，
  // 引擎 wait 长轮询取采集条目再评分。详见 media-studio/collect-jobs.ts。
  const collectBus = createCollectBus();

  app.post('/api/media-studio/collect', (req, res) => {
    const body = (req.body ?? {}) as CreateStudioCollectRequest;
    const keyword = String(body.keyword ?? '').trim();
    if (!keyword) return bad(res, 400, '缺少 keyword');
    const platforms = (Array.isArray(body.platforms) && body.platforms.length
      ? body.platforms
      : ['xiaohongshu', 'douyin', 'bilibili']
    ).filter(isCollectPlatform) as StudioCollectPlatform[];
    if (!platforms.length) return bad(res, 400, `platforms 必须含 ${COLLECT_PLATFORMS.join('|')} 之一`);
    const scrolls = Number.isFinite(Number(body.scrolls)) ? Math.max(0, Math.min(20, Number(body.scrolls))) : 6;
    const per = Number.isFinite(Number(body.per)) ? Math.max(1, Math.min(60, Number(body.per))) : 20;
    const order = (['hot', 'latest', 'comprehensive'].includes(String(body.order))
      ? body.order : 'hot') as 'hot' | 'latest' | 'comprehensive';
    const timeWindow = typeof body.timeWindow === 'string' && body.timeWindow.trim() ? body.timeWindow.trim() : 'all';
    const pages = Number.isFinite(Number(body.pages)) ? Math.max(1, Math.min(10, Number(body.pages))) : 3;
    try {
      const job = collectBus.create({ keyword, platforms, scrolls, per, order, timeWindow, pages });
      res.json({ job });
    } catch (err) {
      if (err instanceof CollectError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/media-studio/collect/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = collectBus.subscribe((job) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    });
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post('/api/media-studio/collect/:id/claim', (req, res) => {
    const job = collectBus.claim(req.params.id);
    if (!job) {
      const existing = collectBus.get(req.params.id);
      if (!existing) return bad(res, 404, 'job not found');
      return bad(res, 409, `job 已被认领(${existing.status})`);
    }
    res.json({ job });
  });

  app.post('/api/media-studio/collect/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = collectBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  // web 采集完回写：results 追加各平台条目；ok=false 或含 needsLogin 也照收，
  // 由引擎侧判断（needsLogin → 提示用户在标签里登录）。
  app.post('/api/media-studio/collect/:id/result', (req, res) => {
    const body = (req.body ?? {}) as StudioCollectResultRequest;
    const results = Array.isArray(body.results) ? body.results : [];
    const job = collectBus.addResult(req.params.id, results);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/collect/:id/complete', (req, res) => {
    const body = (req.body ?? {}) as { ok?: boolean; detail?: string };
    const job = collectBus.complete(req.params.id, body.ok === true, String(body.detail ?? ''));
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/collect/:id', (req, res) => {
    const job = collectBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/collect/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await collectBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // ---- 互动执行派发桥（自动评论/楼中楼/私信 → 桌面端应用内标签执行）----
  // 与 collect 同构:create 建 job + SSE 广播,web 认领后在应用内标签打开目标页拟人回复,
  // 回写进度、complete 终态。差别:建 job 前先过风控台账(claimInteractionSlot),被拦不进总线;
  // 终态时按实际结果落审计。详见 media-studio/interaction-jobs.ts + interaction-quota.ts。
  const interactionBus = createInteractionBus();
  // 风控策略单一来源:先用默认策略,后续 W7/配置化再按账号从 app-config 覆盖。
  const interactionPolicy = () => DEFAULT_INTERACTION_POLICY;

  app.post('/api/media-studio/interaction', (req, res) => {
    const body = (req.body ?? {}) as CreateStudioInteractionRequest;
    const platform = String(body.platform ?? '').trim();
    const action = String(body.action ?? '') as InteractionAction;
    const targetRef = String(body.targetRef ?? '').trim();
    const noteRef = typeof body.noteRef === 'string' && body.noteRef ? body.noteRef : undefined;
    const text = String(body.text ?? '');
    const account = typeof body.account === 'string' && body.account ? body.account : null;
    if (!platform) return bad(res, 400, '缺少 platform');
    if (!['reply', 'sub-reply', 'dm'].includes(action)) return bad(res, 400, 'action 须为 reply|sub-reply|dm');
    if (!targetRef) return bad(res, 400, '缺少 targetRef');
    if (!text.trim()) return bad(res, 400, '缺少 text');
    // 桌面未连接 → 先挡在门外,不消耗配额名额。
    if (interactionBus.subscriberCount() === 0) {
      return bad(res, 409, '桌面端未连接——自动互动需要 social-auto 桌面应用在运行。打开桌面应用后重试。');
    }
    // 风控台账原子认领:被拦则落一条 blocked 审计并回拦截原因,不建 job。
    const decision = claimInteractionSlot(db, platform, account, interactionPolicy());
    if (!decision.allowed) {
      recordInteraction(db, { platform, accountId: account, action, targetRef, text, status: 'blocked', detail: decision.reason ?? null });
      return res.json({
        job: null,
        blocked: {
          reason: decision.reason,
          retryAfterMs: decision.retryAfterMs,
          usedToday: decision.usedToday,
          dailyCap: decision.dailyCap,
        },
      });
    }
    try {
      const job = interactionBus.create({ platform, account, action, targetRef, ...(noteRef ? { noteRef } : {}), text });
      res.json({ job });
    } catch (err) {
      if (err instanceof InteractionError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/media-studio/interaction/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = interactionBus.subscribe((job) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    });
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post('/api/media-studio/interaction/:id/claim', (req, res) => {
    const job = interactionBus.claim(req.params.id);
    if (!job) {
      const existing = interactionBus.get(req.params.id);
      if (!existing) return bad(res, 404, 'job not found');
      return bad(res, 409, `job 已被认领(${existing.status})`);
    }
    res.json({ job });
  });

  app.post('/api/media-studio/interaction/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = interactionBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  // web 执行完回写终态：按实际结果落一条互动审计（配额名额在建 job 时已占,此处不再动配额）。
  app.post('/api/media-studio/interaction/:id/complete', (req, res) => {
    const body = (req.body ?? {}) as { ok?: boolean; detail?: string };
    const ok = body.ok === true;
    const detail = String(body.detail ?? '');
    const job = interactionBus.complete(req.params.id, ok, detail);
    if (!job) return bad(res, 404, 'job not found');
    recordInteraction(db, {
      platform: job.platform,
      accountId: job.account,
      action: job.action,
      targetRef: job.targetRef,
      text: job.text,
      status: ok ? 'done' : 'error',
      detail: ok ? null : (detail || null),
    });
    res.json({ job });
  });

  app.get('/api/media-studio/interaction/:id', (req, res) => {
    const job = interactionBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/interaction/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await interactionBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // 只读预检某账号当前配额（不占名额；供前端置灰按钮/CLI 预判）。
  app.get('/api/media-studio/interaction-quota', (req, res) => {
    const platform = String(req.query.platform ?? '').trim();
    const account = typeof req.query.account === 'string' && req.query.account ? String(req.query.account) : null;
    if (!platform) return bad(res, 400, '缺少 platform');
    res.json(peekInteractionQuota(db, platform, account, interactionPolicy()));
  });

  // 互动审计流水（风控回溯 / 状态面板）。
  app.get('/api/media-studio/interactions', (req, res) => {
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 100;
    const filter: { platform?: string; accountId?: string | null; limit: number } = { limit };
    if (typeof req.query.platform === 'string' && req.query.platform) filter.platform = String(req.query.platform);
    if (req.query.account !== undefined) filter.accountId = req.query.account ? String(req.query.account) : null;
    res.json({ items: listInteractions(db, filter) });
  });

  // ---- 互动匹配规则 CRUD + 匹配测试（自动评论回复的大脑:命中关键词→回复模板）----
  app.get('/api/media-studio/interaction-rules', (req, res) => {
    const platform = String(req.query.platform ?? '').trim();
    if (!platform) return bad(res, 400, '缺少 platform');
    const account = req.query.account === undefined ? undefined : (req.query.account ? String(req.query.account) : null);
    res.json({ items: listInteractionRules(db, platform, account) });
  });

  app.post('/api/media-studio/interaction-rules', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const platform = String(b.platform ?? '').trim();
    const name = String(b.name ?? '').trim();
    const keywords = Array.isArray(b.keywords) ? (b.keywords as unknown[]).map((k) => String(k).trim()).filter(Boolean) : [];
    const replyTemplate = String(b.replyTemplate ?? '');
    if (!platform) return bad(res, 400, '缺少 platform');
    if (!name) return bad(res, 400, '缺少 name');
    if (!keywords.length) return bad(res, 400, '至少一个关键词');
    if (!replyTemplate.trim()) return bad(res, 400, '缺少 replyTemplate');
    const mode = String(b.matchMode ?? 'contains');
    const action = String(b.action ?? 'reply');
    res.json({
      rule: createInteractionRule(db, {
        platform,
        accountId: typeof b.accountId === 'string' && b.accountId ? b.accountId : null,
        name,
        keywords,
        matchMode: (mode === 'exact' || mode === 'regex' ? mode : 'contains'),
        replyTemplate,
        action: (action === 'sub-reply' || action === 'dm' ? action : 'reply'),
        priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0,
        enabled: b.enabled !== false,
      }),
    });
  });

  app.put('/api/media-studio/interaction-rules/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.accountId !== undefined) patch.accountId = typeof b.accountId === 'string' && b.accountId ? b.accountId : null;
    if (typeof b.name === 'string') patch.name = b.name;
    if (Array.isArray(b.keywords)) patch.keywords = (b.keywords as unknown[]).map((k) => String(k).trim()).filter(Boolean);
    if (b.matchMode === 'contains' || b.matchMode === 'exact' || b.matchMode === 'regex') patch.matchMode = b.matchMode;
    if (typeof b.replyTemplate === 'string') patch.replyTemplate = b.replyTemplate;
    if (b.action === 'reply' || b.action === 'sub-reply' || b.action === 'dm') patch.action = b.action;
    if (Number.isFinite(Number(b.priority))) patch.priority = Number(b.priority);
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    const rule = updateInteractionRule(db, req.params.id, patch);
    if (!rule) return bad(res, 404, 'rule not found');
    res.json({ rule });
  });

  app.delete('/api/media-studio/interaction-rules/:id', (req, res) => {
    if (!getInteractionRule(db, req.params.id)) return bad(res, 404, 'rule not found');
    deleteInteractionRule(db, req.params.id);
    res.json({ ok: true });
  });

  // 匹配测试:给一条评论,返回命中的规则+已解析回复(或 null=不回复)。UI 预览/CLI 调试用。
  app.post('/api/media-studio/interaction-rules/match', (req, res) => {
    const b = (req.body ?? {}) as { platform?: string; account?: string | null; comment?: { text?: string; author?: string } };
    const platform = String(b.platform ?? '').trim();
    if (!platform) return bad(res, 400, '缺少 platform');
    const account = b.account === undefined ? undefined : (b.account ? String(b.account) : null);
    const text = String(b.comment?.text ?? '');
    const author = b.comment?.author ? String(b.comment.author) : undefined;
    const rules = listInteractionRules(db, platform, account);
    res.json({ match: matchInteractionRule(rules, author !== undefined ? { text, author } : { text }) });
  });

  // ---- 自动评论回复编排（W8:读评论→匹配规则→拟人回复,把互动运营接成闭环）----
  // dryRun=只出计划(安全预览);真发时逐条过风控台账(冷却/上限自然截断),把回复挂到执行器。
  app.post('/api/media-studio/auto-reply', async (req, res) => {
    const b = (req.body ?? {}) as AutoReplyRequest;
    const platform = String(b.platform ?? '').trim();
    const noteRef = String(b.noteRef ?? '').trim();
    const account = typeof b.account === 'string' && b.account ? b.account : null;
    // 安全默认:只有【显式传 dryRun:false】才真发;缺省/dryRun:true 都只出计划,不外发。
    const isDry = b.dryRun !== false;
    const maxReplies = Number.isFinite(Number(b.maxReplies)) ? Math.max(1, Math.min(20, Number(b.maxReplies))) : 3;
    if (!platform) return bad(res, 400, '缺少 platform');
    if (!noteRef) return bad(res, 400, '缺少 noteRef');
    if (commentReadBus.subscriberCount() === 0) {
      return bad(res, 409, '桌面端未连接——读评论/回复都需要 social-auto 桌面应用在运行。');
    }
    // 1) 读这条笔记的评论(桌面端执行);轮询到终态或读到评论。
    let readJob;
    try {
      readJob = commentReadBus.create({ platform, account, noteRef });
    } catch (err) {
      return bad(res, 409, err instanceof Error ? err.message : String(err));
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await commentReadBus.wait(readJob.id, readJob.progress.length, 4000);
      const j = commentReadBus.get(readJob.id);
      if (!j) break;
      if (j.status === 'done' || j.status === 'error' || j.comments.length > 0 || j.needsLogin) { readJob = j; break; }
      readJob = j;
    }
    const cur = commentReadBus.get(readJob.id) ?? readJob;
    if (cur.needsLogin) return res.json({ read: 0, matched: [], dispatched: [], needsLogin: true, detail: '未登录:请在标签里扫码登录后重试' } satisfies AutoReplyResponse);
    // 2) 拍平评论(一级 + 楼中楼)后逐条过匹配规则。
    const rules = listInteractionRules(db, platform, account);
    const flat: Array<{ id: string; author: string; text: string }> = [];
    for (const c of cur.comments) {
      flat.push({ id: c.id, author: c.author, text: c.text });
      for (const s of c.subReplies ?? []) flat.push({ id: s.id, author: s.author, text: s.text });
    }
    const matched: AutoReplyPlanItem[] = [];
    for (const c of flat) {
      const m = matchInteractionRule(rules, { text: c.text, author: c.author });
      if (m) matched.push({ commentId: c.id, author: c.author, commentText: c.text, ruleName: m.ruleName, reply: m.reply, action: m.action });
    }
    // 3) 预览模式到此为止。
    if (isDry) {
      return res.json({ read: flat.length, matched, dispatched: [] } satisfies AutoReplyResponse);
    }
    // 4) 真发:逐条过风控台账,放行则派发回复 job(楼中楼 noteRef=笔记 URL + targetRef=评论 id;
    //    一级=targetRef 笔记)。冷却/单日上限会自然截断,不会一次性刷屏。
    const dispatched: AutoReplyResponse['dispatched'] = [];
    let sent = 0;
    for (const item of matched) {
      if (sent >= maxReplies) break;
      const decision = claimInteractionSlot(db, platform, account, interactionPolicy());
      if (!decision.allowed) {
        recordInteraction(db, { platform, accountId: account, action: item.action, targetRef: item.commentId, text: item.reply, status: 'blocked', detail: decision.reason ?? null });
        dispatched.push({ ...item, jobId: null, blocked: decision.reason ?? 'blocked' });
        continue;
      }
      try {
        const targetRef = item.action === 'reply' ? noteRef : item.commentId;
        const job = interactionBus.create({ platform, account, action: item.action, targetRef, noteRef, ...(item.author ? { authorName: item.author } : {}), text: item.reply });
        dispatched.push({ ...item, jobId: job.id });
        sent += 1;
      } catch (err) {
        dispatched.push({ ...item, jobId: null, blocked: err instanceof Error ? err.message : String(err) });
      }
    }
    res.json({ read: flat.length, matched, dispatched } satisfies AutoReplyResponse);
  });

  // ---- 登录态保活 + 失效告警 + 扫码补登（W6;2026-07-20 改后台静默探测）----
  // 登录态在桌面端 webview 分区里,daemon 够不着,故校验跑桌面端。心跳/手动建 login-check job →
  // 桌面端【主进程静默读该分区 cookie 票据(+可选服务端验)】判登录态(不开网页、不跳转)→ 回写。
  const loginCheckBus = createLoginCheckBus();

  // 全量扫描:对【所有已绑定账号】各建一个 login-check job(不再只覆盖"检测过一次"的)。
  // 静默探测很轻(主进程读 cookie,不联网或只打一个轻接口),故可覆盖全量 + 勤刷。桌面端没连时空转。
  const sweepLoginChecks = async (): Promise<void> => {
    if (loginCheckBus.subscriberCount() === 0) return; // 没有桌面端执行侧,建了也没人跑
    try {
      const prefs = await readAppConfig(paths.RUNTIME_DATA_DIR);
      for (const p of MEDIA_PLATFORMS.filter((m) => m.kind === 'sau-login')) {
        for (const a of platformAccountsForPlatform(prefs, p.id)) {
          try { loginCheckBus.create({ platform: p.id, account: a.name }); } catch { /* 并发/离线忽略 */ }
        }
      }
    } catch { /* 配置读失败,下轮再来 */ }
  };

  app.post('/api/media-studio/login-check', (req, res) => {
    const b = (req.body ?? {}) as { platform?: string; account?: string };
    const platform = String(b.platform ?? '').trim();
    const account = String(b.account ?? '').trim();
    if (!platform || !account) return bad(res, 400, '缺少 platform/account');
    try {
      res.json({ job: loginCheckBus.create({ platform, account }) });
    } catch (err) {
      if (err instanceof LoginCheckError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/media-studio/login-check/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const unsubscribe = loginCheckBus.subscribe((job) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`));
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000);
    req.on('close', () => { clearInterval(keepalive); unsubscribe(); });
    // 桌面端一连上就先扫一轮所有账号——开 app 即自动刷新登录态,用户不用手点。
    setTimeout(() => { void sweepLoginChecks(); }, 1500);
  });

  app.post('/api/media-studio/login-check/:id/claim', (req, res) => {
    const job = loginCheckBus.claim(req.params.id);
    if (!job) { const e = loginCheckBus.get(req.params.id); return e ? bad(res, 409, `job 已被认领(${e.status})`) : bad(res, 404, 'job not found'); }
    res.json({ job });
  });

  app.post('/api/media-studio/login-check/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = loginCheckBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  // 桌面端回写探测结果:落登录状态;从"已登录→已失效"翻转时产一条告警引导补登。
  app.post('/api/media-studio/login-check/:id/result', (req, res) => {
    const b = (req.body ?? {}) as { loggedIn?: boolean; state?: string; detail?: string };
    const job = loginCheckBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    // 新链路传 state('logged-in'|'logged-out'|'unknown');老链路只传 loggedIn 布尔。
    const state: 'logged-in' | 'logged-out' | 'unknown' =
      b.state === 'logged-in' || b.state === 'logged-out' || b.state === 'unknown'
        ? b.state
        : b.loggedIn === true ? 'logged-in' : 'logged-out';
    const detail = String(b.detail ?? '');
    loginCheckBus.setResult(req.params.id, state === 'logged-in', detail);
    // unknown = 探不出(页面没标记/探测不可用):【不改判】,保留上次已知态。这是"已登录却被
    // 标红失效"误报的根因修复——绝不因为没探到标记就翻成 logged-out。
    if (state !== 'unknown') {
      const flip = setLoginStatus(db, job.platform, job.account, state, detail || null);
      if (flip.flippedToLoggedOut) {
        createAlert(db, { kind: 'login-expired', platform: job.platform, account: job.account, message: `「${job.account}」的${job.platform}登录已失效,请去账号页扫码补登。` });
      }
    }
    res.json({ job: loginCheckBus.get(req.params.id) });
  });

  app.post('/api/media-studio/login-check/:id/complete', (req, res) => {
    const b = (req.body ?? {}) as { ok?: boolean; detail?: string };
    const job = loginCheckBus.complete(req.params.id, b.ok === true, String(b.detail ?? ''));
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/login-check/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await loginCheckBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // 登录状态一览(账号页显示)。
  app.get('/api/media-studio/login-status', (req, res) => {
    const platform = typeof req.query.platform === 'string' && req.query.platform ? String(req.query.platform) : undefined;
    res.json({ items: listLoginStatus(db, platform) });
  });

  // 告警(未消隐的顶显 + 消隐)。
  app.get('/api/media-studio/alerts', (req, res) => {
    res.json({ items: listAlerts(db, { includeDismissed: req.query.all === '1' }) });
  });
  app.post('/api/media-studio/alerts/:id/dismiss', (req, res) => {
    res.json({ ok: dismissAlert(db, req.params.id) });
  });

  // ── 状态监控面板(W7):每个扫码登录账号一行——登录态 + 今日风控名额 + 今日互动战果 ──
  // 把 W1(风控台账)+W6(登录保活)+互动审计汇成一张运营健康看板;按平台分组。CLI/UI 双轨同源。
  app.get('/api/media-studio/monitor', async (req, res) => {
    try {
      const policy = interactionPolicy();
      const tz = policy.tzOffsetMinutes ?? 480; // 划天用 UTC+8
      const now = Date.now();
      const dayStartMs = Math.floor((now + tz * 60_000) / 86_400_000) * 86_400_000 - tz * 60_000;
      const prefs = await readAppConfig(paths.RUNTIME_DATA_DIR);
      const wantPlatform = typeof req.query.platform === 'string' && req.query.platform ? String(req.query.platform) : null;
      // 只看扫码登录类平台(公众号是 API 凭证,不涉及登录保活/互动名额)。
      const platforms = MEDIA_PLATFORMS.filter((p) => p.kind === 'sau-login' && (!wantPlatform || p.id === wantPlatform));
      const items: MonitorAccount[] = [];
      for (const p of platforms) {
        for (const a of platformAccountsForPlatform(prefs, p.id)) {
          const account = a.name; // 全链路以账号名为键(webview 分区/名额/登录态一致)
          const q = peekInteractionQuota(db, p.id, account, policy);
          const audit = listInteractions(db, { platform: p.id, accountId: account, limit: 500 }).filter((r) => r.createdAt >= dayStartMs);
          items.push({
            platform: p.id,
            account,
            login: getLoginStatus(db, p.id, account),
            quota: { usedToday: q.usedToday, dailyCap: q.dailyCap, allowed: q.allowed, ...(q.reason ? { reason: q.reason } : {}), ...(q.retryAfterMs ? { retryAfterMs: q.retryAfterMs } : {}) },
            today: {
              sent: audit.filter((r) => r.status === 'done').length,
              blocked: audit.filter((r) => r.status === 'blocked').length,
              failed: audit.filter((r) => r.status === 'error').length,
            },
          });
        }
      }
      res.json({ items, dayStartMs } satisfies MonitorResponse);
    } catch (err) {
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // 心跳保活:每 5 分钟对【所有已绑定账号】静默校验一轮(桌面在线时)。不用手动首检种下、
  // 不用用户主动登录;掉线由 /result 翻转产告警。静默探测很轻,故比老的 15 分钟更勤。unref 不挡退出。
  const heartbeat = setInterval(() => { void sweepLoginChecks(); }, 5 * 60_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // ---- 读评论派发桥（读一条笔记的评论树 → 桌面端应用内标签执行，不耗互动配额）----
  // 与 collect 同构。互动执行器「先读评论→关键词匹配→自动回复」的读环节；也可 CLI 单独触发看评论。
  const commentReadBus = createCommentReadBus();

  app.post('/api/media-studio/read-comments', (req, res) => {
    const body = (req.body ?? {}) as CreateStudioCommentReadRequest;
    const platform = String(body.platform ?? '').trim();
    const noteRef = String(body.noteRef ?? '').trim();
    const account = typeof body.account === 'string' && body.account ? body.account : null;
    if (!platform) return bad(res, 400, '缺少 platform');
    if (!noteRef) return bad(res, 400, '缺少 noteRef');
    try {
      const job = commentReadBus.create({ platform, account, noteRef });
      res.json({ job });
    } catch (err) {
      if (err instanceof CommentReadError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/media-studio/read-comments/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = commentReadBus.subscribe((job) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000);
    req.on('close', () => { clearInterval(keepalive); unsubscribe(); });
  });

  app.post('/api/media-studio/read-comments/:id/claim', (req, res) => {
    const job = commentReadBus.claim(req.params.id);
    if (!job) {
      const existing = commentReadBus.get(req.params.id);
      if (!existing) return bad(res, 404, 'job not found');
      return bad(res, 409, `job 已被认领(${existing.status})`);
    }
    res.json({ job });
  });

  app.post('/api/media-studio/read-comments/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = commentReadBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/read-comments/:id/result', (req, res) => {
    const body = (req.body ?? {}) as StudioCommentReadResultRequest;
    const comments = Array.isArray(body.comments) ? (body.comments as CommentNode[]) : [];
    const job = commentReadBus.setComments(req.params.id, comments, body.needsLogin === true);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/read-comments/:id/complete', (req, res) => {
    const body = (req.body ?? {}) as { ok?: boolean; detail?: string };
    const job = commentReadBus.complete(req.params.id, body.ok === true, String(body.detail ?? ''));
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/read-comments/:id', (req, res) => {
    const job = commentReadBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/read-comments/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await commentReadBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // ── 「我的笔记」抓取桥(桌面端读账号主页已发笔记 → 互动回复的笔记选择器,免手动贴链接)──
  const myNotesBus = createMyNotesBus();

  app.post('/api/media-studio/my-notes', (req, res) => {
    const b = (req.body ?? {}) as { platform?: string; account?: string | null };
    const platform = String(b.platform ?? '').trim();
    if (!platform) return bad(res, 400, '缺少 platform');
    try {
      res.json({ job: myNotesBus.create({ platform, account: b.account ?? null }) });
    } catch (err) {
      if (err instanceof MyNotesError) return bad(res, 409, err.message);
      bad(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/media-studio/my-notes/:id/claim', (req, res) => {
    const job = myNotesBus.claim(req.params.id);
    if (!job) { const e = myNotesBus.get(req.params.id); return e ? bad(res, 409, `job 已被认领(${e.status})`) : bad(res, 404, 'job not found'); }
    res.json({ job });
  });

  app.post('/api/media-studio/my-notes/:id/progress', (req, res) => {
    const message = String((req.body ?? {}).message ?? '').trim();
    if (!message) return bad(res, 400, '缺少 message');
    const job = myNotesBus.progress(req.params.id, message);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/my-notes/:id/result', (req, res) => {
    const b = (req.body ?? {}) as { notes?: unknown; needsLogin?: boolean };
    const notes = Array.isArray(b.notes) ? (b.notes as import('@open-design/contracts').StudioNoteCard[]) : [];
    const job = myNotesBus.setResult(req.params.id, notes, b.needsLogin === true);
    if (!job) return bad(res, 404, 'job not found or terminal');
    res.json({ job });
  });

  app.post('/api/media-studio/my-notes/:id/complete', (req, res) => {
    const b = (req.body ?? {}) as { ok?: boolean; detail?: string };
    const job = myNotesBus.complete(req.params.id, b.ok === true, String(b.detail ?? ''));
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/my-notes/:id', (req, res) => {
    const job = myNotesBus.get(req.params.id);
    if (!job) return bad(res, 404, 'job not found');
    res.json({ job });
  });

  app.get('/api/media-studio/my-notes/:id/wait', async (req, res) => {
    const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
    const timeoutMs = Number.isFinite(Number(req.query.timeoutMs)) ? Number(req.query.timeoutMs) : 25_000;
    const snap = await myNotesBus.wait(req.params.id, since, timeoutMs);
    if (!snap) return bad(res, 404, 'job not found');
    res.json(snap);
  });

  // ── 桌面端派发任务【合流】SSE(单连接多路复用)──
  // 6 类需桌面端执行的派发任务(handoff/采集/读评论/互动/登录态校验/我的笔记)原本各开一条 SSE,dev
  // 代理是 HTTP/1.1、同源并发连接上限 6,多条常驻 SSE + 记忆面板等会撑爆导致【所有】派发都收不到。
  // 这里把各总线的 pending/新建事件打上 kind 标签并到一条流,web 侧只开这一条 EventSource。
  // 各类【单独的 /xxx/events】仍保留(CLI/兼容),但桌面 web 只用本合流端点。
  app.get('/api/media-studio/desktop-jobs/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const emit = (kind: string, job: unknown) => res.write(`event: job\ndata: ${JSON.stringify({ kind, job })}\n\n`);
    // subscribe 会把各总线里【已 pending】的任务回放给新订阅者,故重连不丢单。
    const unsubs = [
      handoffBus.subscribe((job) => emit('handoff', job)),
      collectBus.subscribe((job) => emit('collect', job)),
      commentReadBus.subscribe((job) => emit('comment-read', job)),
      interactionBus.subscribe((job) => emit('interaction', job)),
      loginCheckBus.subscribe((job) => emit('login-check', job)),
      myNotesBus.subscribe((job) => emit('my-notes', job)),
    ];
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000);
    req.on('close', () => { clearInterval(keepalive); for (const u of unsubs) u(); });
  });

  // 打开文章的资产目录（图集/封面拖拽进浏览器发布页用）。
  app.post('/api/media-studio/:platform/articles/:id/reveal-assets', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const dir = assetsDirFor(article.id);
    await mkdir(dir, { recursive: true });
    revealInFinder(dir);
    res.json({ ok: true, dir });
  });

  // 「一键存草稿」:图片资产的本机绝对路径(桌面端 CDP 注入 file input 用)。
  // 返回 name→absPath,web 侧按图集顺序(extra.noteImages 的 URL)映射组装。
  app.get('/api/media-studio/:platform/articles/:id/asset-paths', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const dir = assetsDirFor(article.id);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const files = entries
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((name) => ({
        name,
        absPath: path.join(dir, name),
        url: `${STUDIO_ASSET_URL_PREFIX}${encodeURIComponent(article.id)}/${encodeURIComponent(name)}`,
      }));
    res.json({ dir, files });
  });

  // 安全发布（手动交接）后回来标记：记录 + 状态推进，让列表/复盘有据可查。
  app.post('/api/media-studio/:platform/articles/:id/mark-published', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const label = String((req.body as any)?.targetLabel ?? '手动发布').slice(0, 60);
    const record = recordPublish(db, {
      articleId: article.id,
      platform: req.params.platform,
      accountId: null,
      accountName: `${label} · 手动`,
      status: 'ok',
      draftMediaId: null,
      failedStep: null,
      error: null,
    });
    markArticlePublished(db, article.id);
    res.json({ record, article: getArticle(db, article.id) });
  });

  // ---- 敏感词扫描（发布预检的警示项;标题+摘要+三段正文一起查） ----
  app.post('/api/media-studio/:platform/articles/:id/lint', (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const text = [article.title, article.digest, article.headerMd, article.bodyMd, article.footerMd].join('\n');
    res.json({ hits: lintContent(text) });
  });

  // ---- 知识库（客户挂载,AI 任务自动注入） ----
  app.get('/api/media-studio/:platform/knowledge', (req, res) => {
    res.json({ items: listKnowledge(db, req.params.platform) });
  });

  app.post('/api/media-studio/:platform/knowledge', (req, res) => {
    const body = (req.body ?? {}) as { name?: string; contentMd?: string; accountId?: string | null; category?: string };
    if (!body.name?.trim()) return bad(res, 400, 'name is required');
    if (!body.contentMd?.trim()) return bad(res, 400, 'contentMd is required');
    const item = createKnowledge(db, req.params.platform, {
      name: body.name.trim(),
      contentMd: body.contentMd,
      accountId: body.accountId ?? null,
      ...(typeof body.category === 'string' && body.category ? { category: body.category } : {}),
    });
    res.json({ item });
  });

  app.delete('/api/media-studio/:platform/knowledge/:id', (req, res) => {
    if (!deleteKnowledge(db, req.params.id)) return bad(res, 404, 'knowledge not found');
    res.json({ ok: true });
  });

  // ---- short-video: 配音（火山 TTS 直调工作台脚本） ----
  app.post('/api/media-studio/:platform/articles/:id/tts', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    try {
      const body = (req.body ?? {}) as { text?: string; voice?: string; preview?: boolean };
      const text = (body.text ?? '').trim() || scriptToSpeech(article.bodyMd);
      if (!text) return bad(res, 400, '没有可配音的文本——先在「脚本」里写口播稿');
      const keys = await resolveStudioKeys(paths.RUNTIME_DATA_DIR, paths.PROJECT_ROOT);
      const dir = assetsDirFor(article.id);
      await mkdir(dir, { recursive: true });
      // preview（试听音色）只产音频不落库，绝不覆盖正式配音。
      const isPreview = body.preview === true;
      const file = `${isPreview ? 'voice-preview' : 'voice'}-${Date.now()}.wav`;
      await synthesizeVoice({
        text,
        ...(body.voice ? { voice: body.voice } : {}),
        outFile: path.join(dir, file),
        env: keys,
      });
      const url = `${STUDIO_ASSET_URL_PREFIX}${encodeURIComponent(article.id)}/${encodeURIComponent(file)}`;
      const updated = isPreview
        ? article
        : updateArticle(db, article.id, { extra: { audioUrl: url, audioVoice: body.voice ?? null } });
      res.json({ url, file, article: updated });
    } catch (err) {
      const status = err instanceof TtsError ? 422 : 500;
      bad(res, status, err instanceof Error ? err.message : String(err));
    }
  });

  // 成片本机上传：大文件走 octet-stream 流（base64 JSON 的 20MB 上限对视频不够）。
  // 落到文章资产目录并直接把绝对路径写进 extra.videoPath（sau 发布用绝对路径）。
  app.post(
    '/api/media-studio/:platform/articles/:id/upload-video',
    express.raw({ type: 'application/octet-stream', limit: '512mb' }),
    async (req, res) => {
      const article = getArticle(db, req.params.id);
      if (!article) return bad(res, 404, 'article not found');
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return bad(res, 400, '没有收到视频数据');
      try {
        const rawName = String(req.headers['x-file-name'] ?? 'video.mp4');
        let decoded = rawName;
        try {
          decoded = decodeURIComponent(rawName);
        } catch {
          /* keep raw */
        }
        const safe = decoded.replace(/[^\w.\-一-龥]+/g, '_').slice(-80) || 'video.mp4';
        const dir = assetsDirFor(article.id);
        await mkdir(dir, { recursive: true });
        const file = `video-${Date.now()}-${safe}`;
        const abs = path.join(dir, file);
        await writeFile(abs, buf);
        const updated = updateArticle(db, article.id, { extra: { videoPath: abs } });
        res.json({ path: abs, article: updated });
      } catch (err) {
        bad(res, 500, err instanceof Error ? err.message : String(err));
      }
    },
  );

  // 封面上传(发布页用户传的封面图 → 存进作品素材目录,记 extra.coverPath;一键存草稿注入时
  // 自动上传到抖音「设置封面」)。与 upload-video 同构,只是存图、写 coverPath。
  app.post(
    '/api/media-studio/:platform/articles/:id/upload-cover',
    express.raw({ type: 'application/octet-stream', limit: '32mb' }),
    async (req, res) => {
      const article = getArticle(db, req.params.id);
      if (!article) return bad(res, 404, 'article not found');
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return bad(res, 400, '没有收到封面数据');
      try {
        const rawName = String(req.headers['x-file-name'] ?? 'cover.jpg');
        let decoded = rawName;
        try {
          decoded = decodeURIComponent(rawName);
        } catch {
          /* keep raw */
        }
        const safe = decoded.replace(/[^\w.\-一-龥]+/g, '_').slice(-80) || 'cover.jpg';
        const dir = assetsDirFor(article.id);
        await mkdir(dir, { recursive: true });
        const file = `cover-${Date.now()}-${safe}`;
        const abs = path.join(dir, file);
        await writeFile(abs, buf);
        const updated = updateArticle(db, article.id, { extra: { coverPath: abs } });
        res.json({ path: abs, article: updated });
      } catch (err) {
        bad(res, 500, err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ---- short-video: sau 登录态与矩阵发布（对外动作,人工确认后才会打到这里） ----
  app.post('/api/media-studio/:platform/sau/check', async (req, res) => {
    try {
      const target = (req.body ?? {}).target as { platform?: string; account?: string } | undefined;
      if (!target?.platform || !target?.account) return bad(res, 400, '缺少 target.platform / target.account');
      const result = await sauCheck(target.platform, target.account);
      res.json(result);
    } catch (err) {
      bad(res, err instanceof SauError ? 422 : 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/media-studio/:platform/sau/login', async (req, res) => {
    try {
      const target = (req.body ?? {}).target as { platform?: string; account?: string } | undefined;
      if (!target?.platform || !target?.account) return bad(res, 400, '缺少 target.platform / target.account');
      // 弹有头浏览器扫码；等用户扫完（最长 5 分钟）。
      const result = await sauLogin(target.platform, target.account);
      res.json(result);
    } catch (err) {
      bad(res, err instanceof SauError ? 422 : 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/media-studio/:platform/articles/:id/publish-video', async (req, res) => {
    const platform = req.params.platform;
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const body = (req.body ?? {}) as {
      targets?: Array<{ platform?: string; account?: string }>;
      videoPath?: string;
      schedule?: string;
    };
    const targets = (body.targets ?? []).filter((t) => t?.platform && t?.account) as Array<{ platform: string; account: string }>;
    if (targets.length === 0) return bad(res, 400, '至少选择一个 平台×账号 发布目标');
    const videoPath = (body.videoPath ?? '').trim() || String(article.extra.videoPath ?? '').trim();
    if (!videoPath) return bad(res, 422, '没有成片——先在「成片」里填视频文件路径');
    if (!path.isAbsolute(videoPath)) return bad(res, 422, '视频路径必须是本机绝对路径');
    const title = article.title.trim();
    if (!title) return bad(res, 422, '标题为空——先在「脚本」里定标题');

    const tags = String(article.extra.tags ?? '').trim();
    const desc = article.digest.trim() || scriptToSpeech(article.bodyMd).slice(0, 120);
    const records = [];
    for (const target of targets) {
      let record;
      try {
        const result = await sauUploadVideo({
          platform: target.platform,
          account: target.account,
          file: videoPath,
          title,
          ...(desc ? { desc } : {}),
          ...(tags ? { tags } : {}),
          ...(body.schedule ? { schedule: body.schedule } : {}),
        });
        record = recordPublish(db, {
          articleId: article.id,
          platform,
          accountId: null,
          accountName: `${target.platform}/${target.account}`,
          status: result.ok ? 'ok' : 'error',
          draftMediaId: null,
          failedStep: result.ok ? null : 'upload',
          error: result.ok ? null : result.detail,
        });
      } catch (err) {
        record = recordPublish(db, {
          articleId: article.id,
          platform,
          accountId: null,
          accountName: `${target.platform}/${target.account}`,
          status: 'error',
          draftMediaId: null,
          failedStep: 'upload',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      records.push(record);
    }
    if (records.some((r) => r.status === 'ok')) markArticlePublished(db, article.id);
    res.json({ records, article: getArticle(db, article.id) });
  });

  // ---- studio AI tasks（组好提示词与会话；执行由 web 走既有 /api/runs） ----
  app.post('/api/media-studio/:platform/ai-task', async (req, res) => {
    try {
      const platform = req.params.platform;
      const body = (req.body ?? {}) as StudioAiTaskRequest;
      const kind = body.kind;
      const KINDS = ['topics', 'write', 'revise', 'ai-check', 'script', 'research', 'review'] as const;
      if (!KINDS.includes(kind as (typeof KINDS)[number])) {
        return bad(res, 400, `kind must be ${KINDS.join(' | ')}`);
      }
      const article = body.articleId ? getArticle(db, body.articleId) : null;
      if (body.articleId && !article) return bad(res, 404, 'article not found');

      // 会覆盖正文的 AI 动作：先自动快照（后悔药），两个创作台都自动受益。
      if (article && (kind === 'write' || kind === 'revise' || kind === 'ai-check' || kind === 'script')) {
        const labels: Record<string, string> = {
          write: 'AI 写一版 前', revise: 'AI 修改前', 'ai-check': '清 AI 腔前', script: 'AI 写脚本前',
        };
        createVersion(db, article, labels[kind] ?? 'AI 动作前');
      }

      // Resolve the bound account's persona so the agent writes in-voice.
      let account: { name: string; persona?: string; samples?: string[] } | null = null;
      const accountId = body.input?.accountId || article?.accountId || null;
      if (accountId) {
        const prefs = await readAppConfig(paths.RUNTIME_DATA_DIR);
        const record = platformAccountsForPlatform(prefs, platform).find((a) => a.id === accountId);
        if (record) {
          account = {
            name: record.name,
            ...(record.style?.persona ? { persona: record.style.persona } : {}),
            ...(record.style?.samples?.length ? { samples: record.style.samples } : {}),
          };
        }
      }

      // 知识库注入：公司级全局库(所有创作台同一份) + 绑定账号的条目一并
      // 带给 AI（截断防提示词爆炸）。
      const knowledgeItems = listKnowledge(db, platform)
        .filter((k) => !k.accountId || k.accountId === (accountId ?? ''))
        .slice(0, 6)
        .map((k) => ({ name: k.name, contentMd: k.contentMd.slice(0, 2000) }));

      const composed = await composeStudioAiTask({
        kind,
        platform,
        article,
        note: String(body.input?.note ?? ''),
        articleType: String(body.input?.articleType ?? ''),
        ...(body.input?.wordCount ? { wordCount: String(body.input.wordCount) } : {}),
        ...(Array.isArray(body.input?.picked) && body.input.picked.length > 0
          ? { picked: body.input.picked.slice(0, 8) }
          : {}),
        account,
        knowledge: knowledgeItems,
        cliPath: path.join(paths.PROJECT_ROOT, 'apps', 'daemon', 'dist', 'cli.js'),
      });

      // One hidden hub project; a fresh conversation per task (回看完整过程).
      const now = Date.now();
      if (!getProject(db, STUDIO_PROJECT_ID)) {
        insertProject(db, {
          id: STUDIO_PROJECT_ID,
          name: '公众号创作台',
          metadata: { kind: 'other', studio: true },
          createdAt: now,
          updatedAt: now,
        });
      }
      const conversation = insertConversation(db, {
        id: randomUUID(),
        projectId: STUDIO_PROJECT_ID,
        title: composed.title,
        createdAt: now,
        updatedAt: now,
      });

      res.json({
        projectId: STUDIO_PROJECT_ID,
        conversationId: (conversation as { id?: string })?.id ?? '',
        prompt: composed.prompt,
        title: composed.title,
      });
    } catch (err) {
      bad(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // ---- topics（选题导航） ----
  app.get('/api/media-studio/:platform/topics', (req, res) => {
    res.json({ topics: listTopics(db, req.params.platform) });
  });

  app.post('/api/media-studio/:platform/topics', (req, res) => {
    const body = (req.body ?? {}) as CreateMediaTopicRequest;
    if (typeof body.title !== 'string' || !body.title.trim()) return bad(res, 400, 'title is required');
    // 入库清洗：AI 偶尔把角度拼进标题（「标题 ｜ 角度：xxx」），拆回各自字段，
    // 否则表格的「角度」列空着、标题列挤成一长串。
    let title = body.title.trim();
    let angle = typeof body.angle === 'string' ? body.angle.trim() : '';
    const m = title.match(/^(.*?)\s*[|｜]\s*角度[:：]\s*(.+)$/);
    if (m) {
      title = m[1]!.trim();
      if (!angle) angle = m[2]!.trim();
    }
    res.json({ topic: createTopic(db, req.params.platform, { ...body, title, ...(angle ? { angle } : {}) }) });
  });

  app.patch('/api/media-studio/:platform/topics/:id', (req, res) => {
    const topic = updateTopic(db, req.params.id, (req.body ?? {}) as UpdateMediaTopicRequest);
    if (!topic) return bad(res, 404, 'topic not found');
    res.json({ topic });
  });

  app.delete('/api/media-studio/:platform/topics/:id', (req, res) => {
    if (!deleteTopic(db, req.params.id)) return bad(res, 404, 'topic not found');
    res.json({ ok: true });
  });

  // ---- snippets（固定开头/结尾片段库） ----
  app.get('/api/media-studio/:platform/snippets', (req, res) => {
    res.json({ snippets: listSnippets(db, req.params.platform) });
  });

  app.post('/api/media-studio/:platform/snippets', (req, res) => {
    const body = (req.body ?? {}) as CreateMediaSnippetRequest;
    if (typeof body.name !== 'string' || !body.name.trim()) return bad(res, 400, 'name is required');
    if (body.slot !== 'header' && body.slot !== 'footer' && body.slot !== 'cover') {
      return bad(res, 400, 'slot must be header, footer or cover');
    }
    res.json({ snippet: createSnippet(db, req.params.platform, { ...body, name: body.name.trim() }) });
  });

  app.delete('/api/media-studio/:platform/snippets/:id', (req, res) => {
    if (!deleteSnippet(db, req.params.id)) return bad(res, 404, 'snippet not found');
    res.json({ ok: true });
  });
}
