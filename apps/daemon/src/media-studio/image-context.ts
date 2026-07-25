// 配图【段落上下文锚定】(2026-07-21 参考 workbuild/煜见 image-context 移植):
// 标注描述常太简短(甚至只有「商务场景」几个字),生图时把标注【所配的正文段落】提出来
// 拼进提示词当场景依据——不管标注写得好坏,画面都锚定在它要配的内容上。老稿(已有简短
// 标注)不用重写也立即受益。
//
// 与本仓已有的「写作时按风格取向标注」(ai-tasks.ts imageStyleGuidance/STYLE_CONTENT_HINT)
// 互补:那个管画面【取向】(信息图 vs 纪实 vs 大字报),这个管画面【锚定到具体段落内容】。
// 画风词仍不在这里写——画风由 qwen-image.composeStylePrompt / contracts.composeImagePrompt
// 单独注入(避免与用户所选风格打架)。
import { IMAGE_STYLE_PRESETS } from '@open-design/contracts';

/** 去 markdown 语法,留纯文案(生图模型只需要内容,不需要格式符号)。 */
function stripMarkdown(block: string): string {
  return block
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 该风格是否允许画面出现文字——与生图负面词同一份真源(IMAGE_STYLE_PRESETS.noText):
 *  白板(图解标签是精髓)/大字报(带文字)/手账(手写感)/none 允许;其余(纪实/摄影/3D/
 *  水彩…)按 preset.noText 禁。未知风格不强加禁字。 */
export function styleAllowsText(style: string | undefined): boolean {
  if (!style) return true; // 缺省=白板,允字
  const preset = IMAGE_STYLE_PRESETS.find((s) => s.id === style);
  return preset ? !preset.noText : true;
}

/** 描述里的「禁字句」——老稿标注是在一刀切禁字时期由 AI 写的,句尾普遍带「画面不含任何
 *  可读文字」;允字风格(大字报/手账/白板)生图时要把它剥掉,否则和风格「可带手写字/大字」
 *  当面矛盾。匹配整个逗号分段(如「干净克制不含任何文字」整段拿掉)。 */
const NO_TEXT_CLAUSE = /[,，;；.。]?\s*[^,，;；.。]*不(?:含|要出现|得出现|出现)(?:任何)?(?:可读)?文字[^,，;；.。]*/g;

export function stripNoTextClauses(description: string): string {
  return description.replace(NO_TEXT_CLAUSE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 把标注描述【锚定到所配段落】:描述当主画面,补上所配段落场景依据 + 文章主题 + 画面要求,
 * 拼成锚定到文章内容的一段【画面内容】。返回的串会作为 description 交给 composeStylePrompt/
 * contracts.composeImagePrompt(它们再套「画风要求/画面内容」结构 + 注入风格前缀),所以这里
 * 只负责内容锚定、绝不写画风词。没有可用段落上下文(如封面标注在最前、找不到上文)则原样返回
 * (允字风格仍先剥掉残留禁字句)。
 */
export function anchorDescriptionToParagraph(
  description: string,
  opts: { context?: string | null; articleTitle?: string; allowText?: boolean } = {},
): string {
  const desc = (opts.allowText ? stripNoTextClauses(description) : description).trim();
  const ctx = opts.context?.trim();
  if (!ctx) return desc; // 无段落依据(如封面):原样,画面靠描述本身
  const head = desc.replace(/[。.\s]+$/, '');
  const title = opts.articleTitle?.trim();
  const titlePart = title ? `,整体气质贴合《${title}》主题` : '';
  return `${head}。画面的场景与主体必须取自所配段落:${ctx}${titlePart}。要求:细节丰富、有明确的视觉主体与景深层次,构图有主次,元素与所配段落强相关、不堆砌无关物件。`;
}

/**
 * 找到 `<!-- IMAGE_<marker>` 标注,返回它上方最近的正文段落(可带最近的小节标题做主题
 * 提示),没有可用上下文返回 null。约定:标注紧跟在要配图的段落后面(写作提示词如此要求),
 * 所以「上一个非空正文块」就是要贴合的段落;若标注紧跟小节标题(小节开头先放图),改取标注
 * 下方第一段。
 */
export function imageMarkerContext(bodyMd: string, marker: string): string | null {
  const safe = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!--\\s*IMAGE_${safe}\\s*[:：]`, 'i');
  const m = re.exec(bodyMd);
  if (!m) return null;
  const isContentBlock = (raw: string): boolean =>
    !!raw && !/^<!--/.test(raw) && !/^!\[/.test(raw) && !/^#{1,6}\s/.test(raw);

  const before = bodyMd.slice(0, m.index).split(/\n\s*\n/);
  let heading = '';
  let para = '';
  let headingAdjacent = false; // 标注是否紧跟在小节标题后(中间无正文)
  for (let i = before.length - 1; i >= 0; i--) {
    const raw = (before[i] ?? '').trim();
    if (!raw) continue;
    if (/^<!--/.test(raw) || /^!\[/.test(raw)) continue; // 别的标注/已插入的图,不是文案
    if (/^#{1,6}\s/.test(raw)) {
      if (!heading) {
        heading = stripMarkdown(raw);
        headingAdjacent = !para;
      }
      continue;
    }
    if (!para) para = stripMarkdown(raw);
    if (para && heading) break;
    if (para && !heading) break;
  }
  // 标注紧跟小节标题(常见:小节开头先放图):要贴合的是【本小节】内容,取标注下方第一段,
  // 别拿上一小节的收尾段当依据。
  if (headingAdjacent) {
    const after = bodyMd.slice(m.index).split(/\n\s*\n/);
    for (const blockRaw of after) {
      const raw = blockRaw.trim();
      if (isContentBlock(raw)) {
        const below = stripMarkdown(raw);
        if (below) {
          para = below;
          break;
        }
      }
    }
  }
  if (!para && !heading) return null;
  const clipped = para.length > 220 ? `${para.slice(0, 220)}…` : para;
  const parts = [heading ? `所在小节:${heading}` : '', clipped].filter(Boolean);
  return parts.join('。');
}
