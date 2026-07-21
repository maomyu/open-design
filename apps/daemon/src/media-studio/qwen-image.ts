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

/** 禁文字风格追加的负面词(模型自写中文十有八九是乱码,除「带文字」风格外全禁)。 */
const NO_TEXT_NEGATIVE = '，任何文字，字幕，标题，水印，字母，汉字，文字条，logo';

/** 扩展风格前缀表(2026-07-17 应用户要求扩到 15+ 常见风格;2026-07-21 从 contracts 挪回
 *  daemon,与煜见对齐——风格提示词是生图内部约定,前端只需 id/label,不再实时预览)。
 *  id 与 packages/contracts IMAGE_STYLE_PRESETS 一一对应;whiteboard/illustrated/clean/none
 *  在 composeStylePrompt 里特判(默认/角色模板/禁字/纯提示词),其余查这张表。
 *  noText=true 追加 NO_TEXT_NEGATIVE;extraNegative=该风格专属负面词(如纪实风的反精致清单)。 */
const STYLE_PRESET_PREFIXES: Record<string, { prefix: string; noText?: boolean; extraNegative?: string }> = {
  // 真实抓拍纪实(2026-07-17 用户定制):核心诉求=去掉一切"AI 完美感/商业摆拍感"。
  // 正向词提炼自用户参考提示词;那一长串"不要"进 extraNegative。
  candid: {
    prefix:
      '真实抓拍照片,纪录片摄影,活动纪实摄影质感。人物状态自然,不看镜头,不摆拍,神情放松专注于手上的事。' +
      '自然光线,普通人真实皮肤纹理,物品有真实使用痕迹、摆放随意不刻意。' +
      '轻微噪点,轻微虚焦,构图略微不完美,生活现场感。不是商业广告,不是摆拍写真。画面内容:',
    noText: true,
    extraNegative:
      '，广告大片感，商业海报，杂志封面感，过度精致，完美布光，棚拍感，网红摆拍，人物看镜头，' +
      '夸张笑容，模特脸，精修皮肤，磨皮，物品摆放整整齐齐，豪华酒店感，廉价培训班感，' +
      '过度虚化，梦幻滤镜，塑料质感，卡通风，插画风，3D渲染，二维码，错误手部，多余手指，脸部变形',
  },
  bigtext: {
    prefix:
      'Bold typographic cover design, one short punchy Chinese headline as the dominant visual element, ' +
      'solid or soft-gradient background, high contrast colors, viral social media cover style, ' +
      'text must be large, sharp and accurate. ',
  },
  'photo-film': {
    prefix:
      'Authentic film photography, Fujifilm color palette, natural window light, candid lifestyle scene, ' +
      'subtle grain, shallow depth of field, thoughtful composition. ',
    noText: true,
  },
  'photo-magazine': {
    prefix:
      'High-end editorial magazine photography, studio lighting, generous negative space, ' +
      'refined muted color grading, premium fashion aesthetic. ',
    noText: true,
  },
  minimal: {
    prefix:
      'Minimalist poster design, large negative space, restrained low-saturation palette, ' +
      'clean geometric composition, premium understated aesthetic. ',
    noText: true,
  },
  'flat-info': {
    prefix:
      'Flat vector infographic illustration, iconified elements, clear sections on a tidy grid, ' +
      'modern business style, crisp edges, harmonious duotone palette, icons only. ',
    noText: true,
  },
  threed: {
    prefix:
      'Cute 3D render in C4D style, soft studio lighting, rounded glossy materials, ' +
      'pastel fresh colors, octane quality, centered hero object. ',
    noText: true,
  },
  guochao: {
    prefix:
      'China-chic guochao illustration, new Chinese style, vermilion red, indigo blue and gold accents, ' +
      'auspicious cloud patterns, traditional motifs with modern flat design. ',
    noText: true,
  },
  journal: {
    prefix:
      'Cozy scrapbook journal collage, washi tape, stickers, polaroid photo frames, ' +
      'handwritten note vibes, warm paper texture, playful layout. ',
  },
  watercolor: {
    prefix:
      'Fresh watercolor painting, translucent washes, soft blooming edges, airy negative space, light clean colors. ',
    noText: true,
  },
  cute: {
    prefix:
      'Adorable chibi cartoon style, big head small body, rounded shapes, soft candy color palette, ' +
      'expressive kawaii faces, sticker-like. ',
    noText: true,
  },
  oil: {
    prefix:
      'Classical oil painting, visible impasto brushstrokes, Rembrandt lighting, rich deep tones, ' +
      'fine art gallery quality. ',
    noText: true,
  },
};

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
  // 工作台是 mac 开发机的本地目录(POSIX venv),客户机(尤其 win)没有——缺席时人话报错,
  // 别让 spawn ENOENT 的原始报错吓客户;主通道(千问/火山 HTTP)不受影响。
  const py = path.join(workbench, '.venv', 'bin', 'python3');
  const fsMod = await import('node:fs');
  if (!fsMod.existsSync(py) || !fsMod.existsSync(script)) {
    throw new QwenImageError('备用生图通道不可用(本机未安装多媒体工作台),请检查主生图模型配置');
  }
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
  /** 多参考图(产品图在前+风格图殿后,有序)——优先于 referenceImage。 */
  referenceImages?: string[];
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
/** 该风格是否允许画面出现文字——与 composeStylePrompt 的负面词口径**同一份真源**
 *  (2026-07-20 用户报「手账风格提示词都带禁字」:上游写作规则/生图组装曾各自
 *  硬编码"除大字报全禁",与本表打架)。允许:whiteboard(图解标签是精髓)/bigtext/
 *  journal(手写感是精髓)/none/illustrated;其余按 noText 禁。 */
export function styleAllowsText(style: string | undefined): boolean {
  if (!style || style === 'whiteboard' || style === 'none' || style === 'illustrated') return true;
  if (style === 'clean') return false;
  const preset = STYLE_PRESET_PREFIXES[style];
  return preset ? !preset.noText : true;
}

/** 风格前缀拼装（qwen 与火山 Seedream 共用同一套画风约定）。
 *  特判:whiteboard 默认 / illustrated 角色模板 / clean 禁字 / none 纯提示词;
 *  其余走 STYLE_PRESET_PREFIXES 扩展表;未知 id 落回默认白板(向后兼容)。
 *  风格前缀直接前置到画面描述(prefix + prompt)——与煜见一致,不再套
 *  【画风要求】/【画面内容】包装头(2026-07-21 用户拍板:手账等风格套中文包装头
 *  出图不一致,挪回 daemon 用直接拼接)。 */
export function composeStylePrompt(style: string | undefined, prompt: string, character?: string): { fullPrompt: string; negative: string } {
  let stylePrefix = WHITEBOARD_STYLE;
  let negative = DEFAULT_NEGATIVE;
  if (style === 'illustrated') {
    stylePrefix = ILLUSTRATED_STYLE_WRAPPER.replace('{character}', character || DEFAULT_ILLUSTRATED_CHARACTER);
  } else if (style === 'clean') {
    stylePrefix = CLEAN_ILLUSTRATION_STYLE;
    negative = DEFAULT_NEGATIVE + NO_TEXT_NEGATIVE;
  } else if (style === 'none') {
    // 不用风格模板(2026-07-09 用户拍板):提示词原样直达模型,画风全由
    // 用户描述决定;负面词仍保底(防低质/水印)。
    stylePrefix = '';
  } else if (style && STYLE_PRESET_PREFIXES[style]) {
    const preset = STYLE_PRESET_PREFIXES[style];
    stylePrefix = preset.prefix;
    if (preset.noText) negative = DEFAULT_NEGATIVE + NO_TEXT_NEGATIVE;
    if (preset.extraNegative) negative += preset.extraNegative;
  }
  return { fullPrompt: (stylePrefix + prompt).slice(0, 800), negative };
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
  // 多图有序注入(产品图在前+风格图殿后);单图字段兜底兼容。
  const qwenRefs = (opts.referenceImages?.length ? opts.referenceImages : (opts.referenceImage?.trim() ? [opts.referenceImage.trim()] : []))
    .map((r) => r.trim()).filter(Boolean);
  for (const r of qwenRefs) {
    // eslint-disable-next-line no-await-in-loop
    requestContent.push(await referenceImageContent(r));
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
