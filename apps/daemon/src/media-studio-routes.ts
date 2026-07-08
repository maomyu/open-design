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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type {
  CreateMediaArticleRequest,
  CreateMediaSnippetRequest,
  CreateMediaTopicRequest,
  GenerateArticleImageRequest,
  MediaRenderRequest,
  StudioAiTaskRequest,
  TopicFeedSearchRequest,
  UpdateMediaArticleRequest,
  UpdateMediaTopicRequest,
} from '@open-design/contracts';
import type { PathDeps, RouteDeps } from './server-context.js';
import { readAppConfig, platformAccountsForPlatform } from './app-config.js';
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
import { generateGeminiImageFallback, generateQwenImage, QwenImageError } from './media-studio/qwen-image.js';
import { generateVolcImage, VolcImageError } from './media-studio/volc-image.js';
import { missingKeyError, resolveStudioKeys } from './media-studio/step-keys.js';
import { composeStudioAiTask } from './media-studio/ai-tasks.js';
import { lintContent } from './media-studio/lint.js';
import { BrowserError, openProfileBrowser, PLATFORM_PUBLISH_URLS, revealInFinder } from './media-studio/browser.js';
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
      const baseName = `img-${(marker ?? 'x').replace(/[^\w-]/g, '')}-${Date.now()}`;
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
      if (model === 'volc') {
        // 火山方舟 Seedream 4.0：独立钥匙（ARK_API_KEY），审查体系与阿里不同，
        // 涉军等题材常常能直出。
        const arkKey = (keys.ARK_API_KEY ?? keys.VOLC_ARK_API_KEY ?? '').trim();
        if (!arkKey) {
          throw new VolcImageError(
            '未配置 ARK_API_KEY——去「插件 · 公众号发布」配置里或工作台 .env 补上火山方舟的 API Key（ark.cn-beijing.volces.com 控制台创建）',
          );
        }
        finalPath = await generateVolcImage({
          prompt: description,
          outFile: path.join(dir, baseName),
          ...(body.style ? { style: body.style } : {}),
          ...(body.ratio ? { ratio: body.ratio } : {}),
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

  // 打开文章的资产目录（图集/封面拖拽进浏览器发布页用）。
  app.post('/api/media-studio/:platform/articles/:id/reveal-assets', async (req, res) => {
    const article = getArticle(db, req.params.id);
    if (!article) return bad(res, 404, 'article not found');
    const dir = assetsDirFor(article.id);
    await mkdir(dir, { recursive: true });
    revealInFinder(dir);
    res.json({ ok: true, dir });
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
    const body = (req.body ?? {}) as { name?: string; contentMd?: string; accountId?: string | null };
    if (!body.name?.trim()) return bad(res, 400, 'name is required');
    if (!body.contentMd?.trim()) return bad(res, 400, 'contentMd is required');
    res.json({
      item: createKnowledge(db, req.params.platform, {
        name: body.name.trim(),
        contentMd: body.contentMd,
        accountId: body.accountId ?? null,
      }),
    });
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

      // 知识库注入：平台级 + 绑定账号的条目一并带给 AI（截断防提示词爆炸）。
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
    res.json({ topic: createTopic(db, req.params.platform, { ...body, title: body.title.trim() }) });
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
