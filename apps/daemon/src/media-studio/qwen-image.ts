/**
 * 通义千问 qwen-image-2.0-pro image generation — TS port of the workbench
 * `generate_image_qwen.py`, hard-won prompt rules preserved verbatim:
 *  - prompt_extend MUST stay false（否则千问改写 prompt 抹平场景差异）;
 *  - style prefixes: whiteboard(默认)/illustrated/clean;
 *  - full prompt capped at 800 chars, negative prompt fixed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { composeImagePrompt, IMAGE_STYLE_PRESETS } from '@open-design/contracts';

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

/** 禁文字风格追加的负面词(模型自写中文十有八九是乱码,除「带文字」风格外全禁)。 */
const NO_TEXT_NEGATIVE = '，任何文字，字幕，标题，水印，字母，汉字，文字条，logo';

// 风格提示词表已上移 packages/contracts IMAGE_STYLE_PRESETS(单一来源,前端预览同源)。


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

/** 阿里云内容安全审查拦截（inappropriate content）——涉军/制服/机构等元素
 *  高概率触发。 */
function isContentBlocked(message: string): boolean {
  return /inappropriate|data_inspection|green/i.test(message);
}

/** 敏感元素中性化改写表：长词在前（先整体替换再兜底单字词），保住画面
 *  构图语义、抹掉审查高危词。 */
const NEUTRAL_REWRITES: Array<[RegExp, string]> = [
  [/军队文职|部队文职/g, '机关单位办公'],
  [/军装|军服|迷彩服|作训服/g, '深色职业正装'],
  [/军官|军人|士兵|战士|文职人员/g, '职场专业人士'],
  [/军营|营区|部队大院|部队|军队/g, '办公园区'],
  [/警服|警察|公安|武警/g, '工作人员'],
  [/国旗|国徽|党旗|党徽|军旗/g, '标识牌'],
  [/枪|弹药|武器|装备库/g, '工作用具'],
  [/制服/g, '职业装'],
];

/** 把提示词里的审查高危元素替换成中性表达；changed=false 表示没词可换。 */
export function neutralizePrompt(prompt: string): { text: string; changed: boolean } {
  let text = prompt;
  for (const [re, to] of NEUTRAL_REWRITES) text = text.replace(re, to);
  return { text, changed: text !== prompt };
}

export interface QwenImageResult {
  file: string;
  /** true = 原提示词被审查拦截，本图用中性化改写后的提示词生成。 */
  neutralized: boolean;
}

/** Generates one image and writes it to outFile (extension adjusted to the
 *  actual content type).
 *  自愈策略：内容审查拦截 → **自动中性化改写提示词**重试一次（不做同词
 *  盲重抽）；429 限流 → 退避 20 秒最多重试两次。仍失败给可操作的人话错误。 */
/** 风格提示词拼装（qwen 与火山 Seedream 共用）。
 *  单一来源:风格提示词/禁字/专属负面词全部来自 contracts IMAGE_STYLE_PRESETS,
 *  组装函数 composeImagePrompt 也与前端「最终提示词预览」共用——所见即所发。
 *  daemon 仅保留 illustrated/clean 的兼容分支(下拉已移除,老稿/旧偏好可能还带)。 */
export function composeStylePrompt(style: string | undefined, prompt: string, character?: string): { fullPrompt: string; negative: string } {
  // 兼容分支:已移除的老风格照旧生效,不走共享表。
  if (style === 'illustrated') {
    const prefix = ILLUSTRATED_STYLE_WRAPPER.replace('{character}', character || DEFAULT_ILLUSTRATED_CHARACTER);
    return { fullPrompt: (prefix + prompt).slice(0, 800), negative: DEFAULT_NEGATIVE };
  }
  if (style === 'clean') {
    return {
      fullPrompt: (CLEAN_ILLUSTRATION_STYLE + prompt).slice(0, 800),
      negative: DEFAULT_NEGATIVE + NO_TEXT_NEGATIVE,
    };
  }
  const preset = IMAGE_STYLE_PRESETS.find((s) => s.id === style)
    ?? IMAGE_STYLE_PRESETS.find((s) => s.id === 'whiteboard')!;
  let negative = DEFAULT_NEGATIVE;
  if (preset.noText) negative += NO_TEXT_NEGATIVE;
  if (preset.extraNegative) negative += preset.extraNegative;
  // 结构化动态注入(分【画风要求】/【画面内容】两段,画风段声明优先级,压过描述里
  // 混入的画风词);none(prompt 为空)保持描述原样直达。组装逻辑在 contracts。
  return { fullPrompt: composeImagePrompt(preset.id, prompt).slice(0, 800), negative };
}

export async function generateQwenImage(opts: QwenImageOptions): Promise<QwenImageResult> {
  let neutralizedTried = false;
  let currentOpts = opts;
  let rateRetries = 0;
  for (;;) {
    try {
      const file = await generateQwenImageOnce(currentOpts);
      return { file, neutralized: neutralizedTried };
    } catch (err) {
      if (!(err instanceof QwenImageError)) throw err;
      if (isContentBlocked(err.message)) {
        if (!neutralizedTried) {
          const rewritten = neutralizePrompt(currentOpts.prompt);
          if (rewritten.changed) {
            neutralizedTried = true;
            currentOpts = { ...currentOpts, prompt: rewritten.text };
            continue;
          }
        }
        throw new QwenImageError(
          neutralizedTried
            ? '提示词已自动中性化改写仍被内容安全拦截——请手动换一种画面说法（换场景/换主体），或配 GEMINI_API_KEY 用备用模型兜底。'
            : '生成结果被阿里云内容安全拦截，且提示词里没有可自动中性化的元素——请换一种画面说法再试，或配 GEMINI_API_KEY 用备用模型兜底。',
        );
      }
      if (/HTTP 429/.test(err.message)) {
        if (rateRetries < 2) {
          rateRetries += 1;
          await new Promise((r) => setTimeout(r, 20_000));
          continue;
        }
        throw new QwenImageError('千问生图触发限流（已自动等待重试仍受限）——歇一分钟再点，或一次少生成几张。');
      }
      throw err;
    }
  }
}

async function generateQwenImageOnce(opts: QwenImageOptions): Promise<string> {
  // 风格拼装统一走 composeStylePrompt(此前这里有份内联重复映射,扩展风格会漂移失效)。
  const { fullPrompt, negative } = composeStylePrompt(opts.style ?? 'whiteboard', opts.prompt, opts.character);
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
    const msg = String(data?.message ?? data?.code ?? '');
    // 只有鉴权类错误才提示查 key；内容审查等业务错误透传原因（外层会重试/翻译）。
    const keyHint = resp.status === 401 || resp.status === 403 ? '（检查 QWEN_API_KEY）' : '';
    throw new QwenImageError(`千问接口 HTTP ${resp.status}: ${msg}${keyHint}`);
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
