/**
 * Deterministic WeChat MP draft publisher（只发草稿箱）.
 *
 * WYSIWYG contract: the draft content is re-rendered from the article's
 * markdown with the SAME renderer the preview uses — preview and draft can
 * never diverge. Every non-mmbiz <img src> is uploaded via /media/uploadimg
 * and swapped in place; the cover goes through /material/add_material.
 * Nothing else about the HTML is touched. draft/add only — no freepublish.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MediaArticle } from '@open-design/contracts';
import { renderWechatHtml } from './wechat-render.js';

const WECHAT_API = 'https://api.weixin.qq.com/cgi-bin';
const FETCH_TIMEOUT_MS = 30_000;

export class WechatPublishError extends Error {
  step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

export interface WechatPublishInput {
  article: MediaArticle;
  credentials: { appid: string; secret: string; author: string };
  /** Maps studio asset URLs (/api/media-studio/assets/...) to local files so
   *  daemon-generated images upload from disk instead of via HTTP loopback. */
  resolveAssetPath?: (src: string) => string | null;
}

export interface WechatPublishOutput {
  draftMediaId: string;
  contentHtml: string;
  uploadedImages: number;
}

interface ImageBytes {
  buffer: Buffer;
  filename: string;
  mime: string;
}

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.gif') return 'image/gif';
  if (e === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function loadImage(src: string, resolveAssetPath?: (s: string) => string | null): Promise<ImageBytes> {
  const assetPath = resolveAssetPath?.(src);
  if (assetPath) {
    const buffer = await readFile(assetPath);
    const ext = path.extname(assetPath) || '.jpg';
    return { buffer, filename: path.basename(assetPath), mime: mimeForExt(ext) };
  }
  if (/^https?:\/\//i.test(src)) {
    const resp = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`下载图片失败 (${resp.status}): ${src}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const urlPath = new URL(src).pathname;
    const ext = path.extname(urlPath) || '.jpg';
    return {
      buffer,
      filename: `image${ext}`,
      mime: resp.headers.get('content-type')?.split(';')[0] || mimeForExt(ext),
    };
  }
  if (!path.isAbsolute(src)) {
    throw new Error(`本地图片必须用绝对路径（收到:${src}）`);
  }
  const buffer = await readFile(src);
  const ext = path.extname(src) || '.jpg';
  return { buffer, filename: path.basename(src), mime: mimeForExt(ext) };
}

async function wechatJson(resp: Response, step: string): Promise<Record<string, unknown>> {
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const errcode = typeof data.errcode === 'number' ? data.errcode : 0;
  if (errcode !== 0) {
    let hint = '';
    if (errcode === 40164) hint = '（本机公网 IP 不在公众号 IP 白名单里，去公众平台「基本配置」添加）';
    if (errcode === 40001 || errcode === 41002) hint = '（AppID/AppSecret 不正确或已重置）';
    if (errcode === 45166) hint = '（标题超长，需 ≤64 字节 ≈ 21 个中文字符）';
    throw new WechatPublishError(step, `微信接口错误 ${errcode}: ${String(data.errmsg ?? '')}${hint}`);
  }
  return data;
}

async function getAccessToken(appid: string, secret: string): Promise<string> {
  const url = `${WECHAT_API}/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new WechatPublishError('token', `请求微信 token 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = await wechatJson(resp, 'token');
  const token = data.access_token;
  if (typeof token !== 'string' || !token) throw new WechatPublishError('token', 'access_token 为空');
  return token;
}

async function uploadInlineImage(token: string, image: ImageBytes): Promise<string> {
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(image.buffer)], { type: image.mime }), image.filename);
  const resp = await fetch(`${WECHAT_API}/media/uploadimg?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await wechatJson(resp, 'upload');
  const url = data.url;
  if (typeof url !== 'string' || !url) throw new WechatPublishError('upload', 'uploadimg 未返回 url');
  return url;
}

async function uploadCover(token: string, image: ImageBytes): Promise<string> {
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(image.buffer)], { type: image.mime }), image.filename);
  const resp = await fetch(
    `${WECHAT_API}/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  const data = await wechatJson(resp, 'cover');
  const mediaId = data.media_id;
  if (typeof mediaId !== 'string' || !mediaId) throw new WechatPublishError('cover', 'add_material 未返回 media_id');
  return mediaId;
}

/** Plain-text digest fallback: strip md markers, first ~100 chars. */
function digestFrom(article: MediaArticle): string {
  if (article.digest.trim()) return article.digest.trim().slice(0, 120);
  const text = article.bodyMd
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*`\-\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 100);
}

export async function publishWechatDraft(input: WechatPublishInput): Promise<WechatPublishOutput> {
  const { article, credentials } = input;

  const title = article.title.trim();
  if (!title) throw new WechatPublishError('draft', '标题为空——发布前先在「写作」里填标题');
  if (Buffer.byteLength(title, 'utf8') > 64) {
    throw new WechatPublishError('draft', `标题超长（${Buffer.byteLength(title, 'utf8')} 字节 > 64，约 21 个中文字符）`);
  }

  // WYSIWYG: always re-render from markdown at publish time.
  const rendered = renderWechatHtml({
    headerMd: article.headerMd,
    bodyMd: article.bodyMd,
    footerMd: article.footerMd,
    skin: article.skin,
  });
  let content = rendered.html;

  const token = await getAccessToken(credentials.appid, credentials.secret);

  // Upload every non-mmbiz image and swap its src in place.
  const uniqueSrcs = [...new Set(rendered.localImageSrcs)];
  const loaded = new Map<string, ImageBytes>();
  for (const src of uniqueSrcs) {
    let image: ImageBytes;
    try {
      image = await loadImage(src, input.resolveAssetPath);
    } catch (err) {
      throw new WechatPublishError('upload', err instanceof Error ? err.message : String(err));
    }
    loaded.set(src, image);
    const mmbizUrl = await uploadInlineImage(token, image);
    content = content.split(`src="${src.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}"`).join(`src="${mmbizUrl}"`);
    // Rate-limit courtesy for image-heavy articles.
    if (uniqueSrcs.length > 3) await new Promise((r) => setTimeout(r, 800));
  }
  if (/src="(?!https?:\/\/mmbiz\.qpic\.cn\/)/.test(content)) {
    const leftover = content.match(/src="([^"]+)"/g)?.filter((m) => !m.includes('mmbiz.qpic.cn')) ?? [];
    if (leftover.length > 0) {
      throw new WechatPublishError('upload', `仍有未替换的图片 src:${leftover.slice(0, 3).join(', ')}`);
    }
  }

  // Cover: explicit coverSource, else the first in-body image.
  const coverSrc = article.coverSource.trim() || uniqueSrcs[0] || '';
  if (!coverSrc) {
    throw new WechatPublishError('cover', '没有封面：在「发布」里填封面图（URL 或本地绝对路径），或在正文插入至少一张图片');
  }
  let coverImage = loaded.get(coverSrc);
  if (!coverImage) {
    try {
      coverImage = await loadImage(coverSrc, input.resolveAssetPath);
    } catch (err) {
      throw new WechatPublishError('cover', err instanceof Error ? err.message : String(err));
    }
  }
  const thumbMediaId = await uploadCover(token, coverImage);

  const draftBody = {
    articles: [
      {
        title,
        digest: digestFrom(article),
        content,
        thumb_media_id: thumbMediaId,
        need_open_comment: 1,
        only_fans_can_comment: 0,
        ...(credentials.author ? { author: credentials.author } : {}),
      },
    ],
  };
  const resp = await fetch(`${WECHAT_API}/draft/add?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(draftBody),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await wechatJson(resp, 'draft');
  const mediaId = data.media_id;
  if (typeof mediaId !== 'string' || !mediaId) throw new WechatPublishError('draft', 'draft/add 未返回 media_id');

  return { draftMediaId: mediaId, contentHtml: content, uploadedImages: uniqueSrcs.length };
}
