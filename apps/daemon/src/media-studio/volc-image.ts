/**
 * 火山引擎（Volcengine）方舟 Ark 文生图 — Seedream 4.0（豆包·即梦系列，
 * 2025-08 版）。走 Ark 的 OpenAI 兼容 images 接口，鉴权用方舟 API Key
 * （ARK_API_KEY，注意与火山 TTS 的 VOLC_TTS_API_KEY 不是同一把钥匙）。
 * 画风前缀与千问共用同一套约定（composeStylePrompt）。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { composeStylePrompt } from './qwen-image.js';

const ARK_IMAGE_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
// 2026-07-08 从方舟官方文档实锤的可用版本(用户拍板用最新):
//   doubao-seedream-5-0-260128（默认,质量最高）
//   doubao-seedream-5-0-lite-260128（快/省,支持联网搜索生图）
//   doubao-seedream-4-5-251128 / doubao-seedream-4-0-250828
// 切版本不改代码:「设置→媒体生成→Volcengine Ark」自定义模型字段覆盖。
const DEFAULT_MODEL = 'doubao-seedream-5-0-260128';
const TIMEOUT_MS = 120_000;

/** Seedream 用具体像素尺寸；5.0 实测要求 ≥3,686,400 像素（2K 档），
 *  16:9/9:16 用 2560×1440 满足下限，其余档位本就达标。 */
const SIZE_MAP: Record<string, string> = {
  '16:9': '2560x1440',
  '9:16': '1440x2560',
  '1:1': '2048x2048',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
};

export class VolcImageError extends Error {}

export interface VolcImageOptions {
  prompt: string;
  outFile: string;
  style?: string;
  ratio?: string;
  apiKey: string;
  /** 覆盖默认模型 id（将来 Seedream 升级只改这里/环境变量）。 */
  model?: string;
}

export async function generateVolcImage(opts: VolcImageOptions): Promise<string> {
  const { fullPrompt } = composeStylePrompt(opts.style, opts.prompt);
  const payload = {
    model: opts.model || DEFAULT_MODEL,
    prompt: fullPrompt,
    size: SIZE_MAP[opts.ratio ?? '4:3'] ?? SIZE_MAP['4:3']!,
    response_format: 'url',
    watermark: false,
  };

  let resp: Response;
  try {
    resp = await fetch(ARK_IMAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new VolcImageError(`火山生图请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (!resp.ok) {
    const msg = String(data?.error?.message ?? data?.message ?? data?.code ?? '');
    const keyHint = resp.status === 401 || resp.status === 403
      ? '（检查 ARK_API_KEY——注意是火山方舟的 API Key，不是 TTS 的那把）'
      : '';
    throw new VolcImageError(`火山 Seedream HTTP ${resp.status}: ${msg}${keyHint}`);
  }
  const imageUrl = data?.data?.[0]?.url;
  if (typeof imageUrl !== 'string' || !imageUrl) {
    throw new VolcImageError('火山 Seedream 响应里没有图片 URL');
  }

  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!imgResp.ok) throw new VolcImageError(`图片下载失败 HTTP ${imgResp.status}`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const contentType = imgResp.headers.get('content-type') ?? 'image/png';
  const ext = /jpe?g/.test(contentType) ? '.jpg' : '.png';
  let outFile = opts.outFile;
  if (!/\.(png|jpe?g)$/i.test(outFile)) outFile = outFile + ext;
  await writeFile(outFile, buf);
  return path.resolve(outFile);
}
