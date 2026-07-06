/**
 * 通义千问 qwen-image-2.0-pro image generation — TS port of the workbench
 * `generate_image_qwen.py`, hard-won prompt rules preserved verbatim:
 *  - prompt_extend MUST stay false（否则千问改写 prompt 抹平场景差异）;
 *  - style prefixes: whiteboard(默认)/illustrated/clean;
 *  - full prompt capped at 800 chars, negative prompt fixed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const TIMEOUT_MS = 120_000;

const SIZE_MAP: Record<string, string> = {
  '16:9': '2688*1536',
  '9:16': '1536*2688',
  '1:1': '2048*2048',
  '4:3': '2368*1728',
  '3:4': '1728*2368',
};

const DEFAULT_ILLUSTRATED_CHARACTER =
  'an elderly Chinese woman character with gray hair in a bun, rosy cheeks, wearing traditional Chinese red-brown clothing';

const ILLUSTRATED_STYLE_WRAPPER =
  'Soft watercolor cartoon illustration style, featuring {character}, warm pastel color palette, earthy tones, ' +
  "children's book aesthetic, gentle and whimsical mood, Chinese text overlay in the image. ";

const WHITEBOARD_STYLE =
  'Whiteboard illustration style, hand-drawn with colored markers, clean white background, sketch-like diagrams and text, ' +
  'professional but casual, minimalist line art. ';

const CLEAN_ILLUSTRATION_STYLE =
  'Soft warm watercolor illustration, warm pastel color palette, earthy cozy tones, gentle storybook mood, ' +
  'no text, no captions, no letters, no words anywhere in the image, clean illustration without any text overlay. ';

const DEFAULT_NEGATIVE =
  '低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。';

export class QwenImageError extends Error {}

/** Gemini 兜底：spawn 工作台 generate_image_gemini.py（千问失败时用）。 */
export async function generateGeminiImageFallback(opts: {
  prompt: string;
  outFile: string;
  ratio?: string;
  env: Record<string, string>;
}): Promise<string> {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const workbench = path.join(
    process.env.OD_WORKBENCH_DIR || path.join(os.homedir(), '.open-design', 'workbenches'),
    '多媒体自动发布',
  );
  const script = path.join(workbench, '.claude', 'skills', 'MY-wechat-shared', 'scripts', 'generate_image_gemini.py');
  const py = path.join(workbench, '.venv', 'bin', 'python3');
  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, '--prompt', opts.prompt, '--output', opts.outFile, '--aspect-ratio', opts.ratio ?? '4:3'], {
      cwd: workbench,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new QwenImageError('Gemini 兜底超时（120s）'));
    }, 120_000);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new QwenImageError(`Gemini 兜底启动失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(opts.outFile);
      else reject(new QwenImageError(`Gemini 兜底失败（exit ${code}）: ${out.trim().slice(-300)}`));
    });
  });
}

export interface QwenImageOptions {
  prompt: string;
  outFile: string;
  style?: string;
  ratio?: string;
  character?: string;
  /** Reference image steering the generation: http(s) URL or local absolute
   *  path (local files are inlined as base64 data URIs). */
  referenceImage?: string;
  apiKey: string;
}

async function referenceImageContent(ref: string): Promise<{ image: string }> {
  if (/^https?:\/\//i.test(ref)) return { image: ref };
  if (!path.isAbsolute(ref)) throw new QwenImageError(`参考图必须是 URL 或本地绝对路径（收到:${ref}）`);
  const buf = await readFile(ref);
  const ext = path.extname(ref).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { image: `data:${mime};base64,${buf.toString('base64')}` };
}

/** Generates one image and writes it to outFile (extension adjusted to the
 *  actual content type). Returns the final absolute file path. */
export async function generateQwenImage(opts: QwenImageOptions): Promise<string> {
  const style = opts.style ?? 'whiteboard';
  let stylePrefix = WHITEBOARD_STYLE;
  let negative = DEFAULT_NEGATIVE;
  if (style === 'illustrated') {
    stylePrefix = ILLUSTRATED_STYLE_WRAPPER.replace('{character}', opts.character || DEFAULT_ILLUSTRATED_CHARACTER);
  } else if (style === 'clean') {
    stylePrefix = CLEAN_ILLUSTRATION_STYLE;
    negative = DEFAULT_NEGATIVE + '，任何文字，字幕，标题，水印，字母，汉字，文字条，logo';
  }
  const fullPrompt = (stylePrefix + opts.prompt).slice(0, 800);
  const size = SIZE_MAP[opts.ratio ?? '4:3'] ?? SIZE_MAP['4:3']!;

  const requestContent: Array<Record<string, string>> = [];
  if (opts.referenceImage?.trim()) {
    requestContent.push(await referenceImageContent(opts.referenceImage.trim()));
  }
  requestContent.push({ text: fullPrompt });
  const payload = {
    model: 'qwen-image-2.0-pro',
    input: { messages: [{ role: 'user', content: requestContent }] },
    parameters: { size, n: 1, prompt_extend: false, watermark: false, negative_prompt: negative },
  };

  let resp: Response;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new QwenImageError(`千问生图请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (!resp.ok) {
    throw new QwenImageError(`千问接口 HTTP ${resp.status}: ${String(data?.message ?? data?.code ?? '')}（检查 QWEN_API_KEY）`);
  }
  const content: Array<Record<string, unknown>> = data?.output?.choices?.[0]?.message?.content ?? [];
  const imageUrl = content.map((c) => c.image).find((v): v is string => typeof v === 'string');
  if (!imageUrl) throw new QwenImageError('千问响应里没有图片 URL');

  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!imgResp.ok) throw new QwenImageError(`图片下载失败 HTTP ${imgResp.status}`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const contentType = imgResp.headers.get('content-type') ?? 'image/png';
  const ext = /jpe?g/.test(contentType) ? '.jpg' : '.png';
  let outFile = opts.outFile;
  if (!/\.(png|jpe?g)$/i.test(outFile)) outFile = outFile + ext;
  await writeFile(outFile, buf);
  return path.resolve(outFile);
}
