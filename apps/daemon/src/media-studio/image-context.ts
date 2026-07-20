// 配图段落上下文(2026-07-20 用户反馈"公众号配图与所在段落无关"):
// 标注描述常太简短(甚至只有「商务场景」几个字),生图时把标注【前面那个段落】
// 提出来拼进提示词当场景依据——不管标注写得好坏,画面都锚定在它要配的内容上。
// 老稿子(已有简短标注)不用重写也立即受益。

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

/** 组发给生图模型的最终提示词(2026-07-20 用户反馈"提示词太少不细致,图与文章
 *  无关"):标注描述只是主画面,这里补上文章主题、所配段落依据和画面要求,拼成
 *  结构化分镜提示词——比单句描述细得多,画面强制锚定文章内容。风格词不在这里
 *  写(style 预设单独传引擎,避免与用户选的风格打架)。 */
export function composeImagePrompt(
  description: string,
  opts: { context?: string | null; articleTitle?: string; allowText?: boolean } = {},
): string {
  const ctx = opts.context?.trim();
  if (!ctx) return description;
  const title = opts.articleTitle?.trim();
  // 「带文字」类风格(如大字报)允许画字,禁字条款会跟风格打架——按 allowText 收放。
  const textRule = opts.allowText ? '' : ';画面中不要出现任何可读文字、水印或 logo';
  return [
    `主画面:${description}`,
    title ? `文章主题:《${title}》——画面气质要与主题相符。` : '',
    `所配段落(画面的场景与主体必须来自这段内容):${ctx}`,
    `画面要求:细节丰富、有明确的视觉主体和景深层次,构图有主次,光线与氛围服务段落情绪;元素与所配段落强相关,不堆砌无关物件${textRule}。`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 找到 `<!-- IMAGE_<marker>` 标注,返回它上方最近的正文段落(可带最近的小节
 * 标题做主题提示),没有可用上下文返回 null。约定:标注紧跟在要配图的段落后面
 * (写作提示词如此要求),所以「上一个非空块」就是要贴合的段落。
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
  // 标注紧跟小节标题(常见:小节开头先放图):要贴合的是【本小节】内容,取标注
  // 下方第一段,别拿上一小节的收尾段当依据。
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
