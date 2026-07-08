/**
 * Deterministic WeChat MP (公众号) markdown → HTML renderer.
 *
 * Ports the workbench `MY-wechat-shared/styles.json` skins into product code
 * and encodes every hard rule that used to live in prompt text:
 *
 *  - output is a self-contained fully-inlined `<section>` fragment
 *    (no <style>/<head>/<body>) — what you preview is what gets drafted;
 *  - the body NEVER renders an H1: a leading `# title` line is stripped
 *    (the title travels in draft/add's own `title` field), any other H1
 *    downgrades to H2;
 *  - lists are hand-numbered plain `<p>`s — WeChat's editor strips
 *    <ol>/<ul>/<li> numbering, so those tags are never emitted;
 *  - only WeChat-safe tags are used: section/p/h2/h3/blockquote/strong/em/
 *    span/img/br/a/code;
 *  - `<!-- IMAGE_N: 描述 -->` placeholders are skipped with a note (they are
 *    authoring markers, not content); `![alt](src)` renders a centered <img>
 *    whose local src the publisher later swaps for a mmbiz URL.
 */

export interface WechatSkin {
  id: string;
  name: string;
  /** Heading / emphasis color. */
  titleColor: string;
  textColor: string;
  /** Container background; empty = no explicit background. */
  bgColor: string;
  quoteBg: string;
  quoteBorder: string;
  highlightBg: string;
  linkColor: string;
  headingFont: string;
  bodyFont: string;
  /** 章节标题形态：bar=左竖条+虚线底(编辑风) / highlight=渐变半高亮(杂志风) / minimal=细线极简(留白风)。 */
  headingStyle: 'bar' | 'highlight' | 'minimal';
  /** 标题文字色（默认同 titleColor；绿色/橙色系主题标题用深色、strong 用主色时分开）。 */
  headingColor: string;
  codeFont: string;
  h2FontSize: string;
  h3FontSize: string;
  bodyFontSize: string;
  lineHeight: string;
  letterSpacing: string;
  /** Container chrome — kaiti's rounded card; others keep a plain frame. */
  containerRadius: string;
  containerShadow: string;
  maxWidth: string;
}

const BASE: Omit<WechatSkin, 'id' | 'name' | 'titleColor' | 'textColor' | 'quoteBg' | 'quoteBorder' | 'linkColor' | 'headingFont'> = {
  bgColor: '',
  highlightBg: '',
  bodyFont: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
  codeFont: "'Source Code Pro', Consolas, Menlo, monospace",
  headingStyle: 'bar' as const,
  headingColor: '',
  h2FontSize: '20px',
  h3FontSize: '17px',
  bodyFontSize: '15px',
  lineHeight: '2',
  letterSpacing: '0.05em',
  containerRadius: '',
  containerShadow: '',
  maxWidth: '680px',
};

export const WECHAT_SKINS: WechatSkin[] = [
  {
    ...BASE,
    id: 'kaiti',
    name: 'kaiti · 深红棕楷体',
    titleColor: '#8B1E22',
    textColor: '#333333',
    bgColor: '#F9F8F4',
    quoteBg: 'rgba(139, 30, 34, 0.03)',
    quoteBorder: '#891E22',
    highlightBg: 'rgba(139, 30, 34, 0.1)',
    linkColor: '#8B1E22',
    headingFont: 'KaiTi, STKaiti, SimSun, serif',
    letterSpacing: '0.1em',
    containerRadius: '24px',
    containerShadow: 'rgba(0, 0, 0, 0.06) 0px 12px 35px',
  },
  {
    ...BASE,
    id: 'moyu-green',
    name: '摸鱼绿 · 杂志风',
    titleColor: '#059669',
    headingColor: '#111827',
    headingStyle: 'highlight' as const,
    textColor: '#374151',
    quoteBg: '#F9FAFB',
    quoteBorder: '#D1D5DB',
    highlightBg: '#FDE68A',
    linkColor: '#059669',
    headingFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '14px',
    lineHeight: '1.9',
    letterSpacing: '0.5px',
  },
  {
    ...BASE,
    id: 'red-white',
    name: '红白色系 · 编辑风',
    titleColor: '#DC2626',
    headingColor: '#1C1917',
    headingStyle: 'bar' as const,
    textColor: '#374151',
    quoteBg: '#FEF2F2',
    quoteBorder: '#FECACA',
    highlightBg: '#FEE2E2',
    linkColor: '#DC2626',
    headingFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '15px',
    lineHeight: '1.8',
    letterSpacing: '0.5px',
  },
  {
    ...BASE,
    id: 'graphite',
    name: '石墨极简',
    titleColor: '#27272A',
    headingColor: '#27272A',
    headingStyle: 'minimal' as const,
    textColor: '#52525B',
    quoteBg: '#FAFAFA',
    quoteBorder: '#E4E4E7',
    highlightBg: '#F4F4F5',
    linkColor: '#F97316',
    headingFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '15px',
    lineHeight: '1.8',
    letterSpacing: '0.3px',
  },
  {
    ...BASE,
    id: 'zen',
    name: '留白禅意',
    titleColor: '#4A5D52',
    headingColor: '#2B2B2B',
    headingStyle: 'minimal' as const,
    textColor: '#525252',
    quoteBg: '#EEF3F0',
    quoteBorder: '#E8E8E8',
    highlightBg: '#D6E4DC',
    linkColor: '#4A5D52',
    headingFont: "'Noto Serif SC', Georgia, 'Times New Roman', serif",
    bodyFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '15px',
    lineHeight: '1.9',
    letterSpacing: '0.3px',
  },
  {
    ...BASE,
    id: 'ticket',
    name: '摸鱼票据',
    titleColor: '#059669',
    headingColor: '#1a1a1a',
    headingStyle: 'highlight' as const,
    textColor: '#555555',
    bgColor: '#fffef8',
    quoteBg: '#F0FDF4',
    quoteBorder: '#A7F3D0',
    highlightBg: '#A7F3D0',
    linkColor: '#059669',
    headingFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFont: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '14px',
    lineHeight: '1.9',
    letterSpacing: '0.5px',
  },
  {
    ...BASE,
    id: 'olive',
    name: '橄榄手记 · 内刊风',
    titleColor: '#ed7b2f',
    headingColor: '#23251d',
    headingStyle: 'minimal' as const,
    textColor: '#4d4f46',
    bgColor: '#fdfdf8',
    quoteBg: '#eeefe9',
    quoteBorder: '#bfc1b7',
    highlightBg: '#e5e7e0',
    linkColor: '#ed7b2f',
    headingFont: "'IBM Plex Sans', -apple-system, system-ui, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFont: "'IBM Plex Sans', -apple-system, system-ui, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    bodyFontSize: '14px',
    lineHeight: '1.9',
    letterSpacing: '0.5px',
    containerRadius: '6px',
  },
];

export const DEFAULT_WECHAT_SKIN = 'kaiti';

export function getWechatSkin(id: string | null | undefined): WechatSkin {
  return WECHAT_SKINS.find((s) => s.id === id) ?? WECHAT_SKINS[0]!;
}

export interface WechatRenderInput {
  headerMd?: string | null;
  bodyMd?: string | null;
  footerMd?: string | null;
  skin?: string | null;
  /** 正文字号 px（12-22，默认取皮肤的 15）。 */
  bodyFontSize?: number | null;
  /** 小节标题（##）字号 px（14-30，默认取皮肤的 20；### 自动 -3px）。 */
  headingFontSize?: number | null;
}

/** 从文章 extra 里取用户设置的字号（写作页 +/- 调的），持久渲染与发布共用。 */
export function fontSizesFromExtra(extra: unknown): Pick<WechatRenderInput, 'bodyFontSize' | 'headingFontSize'> {
  const rec = (extra ?? {}) as Record<string, unknown>;
  return {
    ...(typeof rec.bodyFontSize === 'number' ? { bodyFontSize: rec.bodyFontSize } : {}),
    ...(typeof rec.headingFontSize === 'number' ? { headingFontSize: rec.headingFontSize } : {}),
  };
}

export interface WechatRenderResult {
  html: string;
  skin: string;
  notes: string[];
  /** img srcs that are NOT already mmbiz URLs (publisher must upload+swap). */
  localImageSrcs: string[];
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** Inline markdown → WeChat-safe inline HTML. Input must be raw (unescaped). */
function renderInline(raw: string, skin: WechatSkin): string {
  // Images inline are extracted at block level; here handle text spans only.
  let out = '';
  let rest = escapeHtml(raw);
  // `code`
  rest = rest.replace(/`([^`]+)`/g, (_m, code: string) =>
    `<span style="font-family: ${skin.codeFont};background: rgba(0,0,0,0.05);padding: 2px 5px;border-radius: 4px;font-size: 13px;">${code}</span>`);
  // **bold** → theme-colored strong
  rest = rest.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) =>
    `<strong style="color: ${skin.titleColor};">${t}</strong>`);
  // *em*
  rest = rest.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_m, pre: string, t: string) =>
    `${pre}<em>${t}</em>`);
  // [text](url) — keep http(s) only
  rest = rest.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t: string, u: string) =>
    `<a href="${escapeAttr(u)}" style="color: ${skin.linkColor};text-decoration: none;border-bottom: 1px solid ${skin.linkColor};">${t}</a>`);
  out += rest;
  return out;
}

function pStyle(skin: WechatSkin): string {
  return `margin: 1.2em 0px;letter-spacing: ${skin.letterSpacing};color: ${skin.textColor};text-align: justify;line-height: ${skin.lineHeight};font-size: ${skin.bodyFontSize};font-family: ${skin.bodyFont};`;
}


function headingColorOf(skin: WechatSkin): string {
  return skin.headingColor || skin.titleColor;
}

/** 章节标题（##）按皮肤形态渲染：bar 编辑风 / highlight 杂志高亮 / minimal 细线极简。 */
function renderHeading(text: string, skin: WechatSkin): string {
  const color = headingColorOf(skin);
  if (skin.headingStyle === 'highlight') {
    return (
      `<h2 style="margin: 2.2em 0px 0.9em;font-size: ${skin.h2FontSize};font-weight: 900;line-height: 1.5;letter-spacing: ${skin.letterSpacing};font-family: ${skin.headingFont};color: ${color};">` +
      `<span style="background: linear-gradient(180deg, transparent 62%, ${skin.highlightBg} 62%);padding: 0px 4px;">${text}</span>` +
      `</h2>`
    );
  }
  if (skin.headingStyle === 'minimal') {
    return (
      `<h2 style="margin: 2.6em 0px 1em;padding: 0px 0px 0.55em;border-bottom: 1px solid ${skin.quoteBorder};font-size: ${skin.h2FontSize};font-weight: 700;line-height: 1.5;letter-spacing: ${skin.letterSpacing};font-family: ${skin.headingFont};color: ${color};">${text}</h2>`
    );
  }
  return (
    `<h2 style="margin: 2em 0px 0.75em;padding: 0px 0px 0.5em 12px;border-left: 4px solid ${skin.titleColor};border-bottom: 1px dashed ${skin.quoteBorder};font-size: ${skin.h2FontSize};font-weight: bold;color: ${color};letter-spacing: ${skin.letterSpacing};font-family: ${skin.headingFont};">${text}</h2>`
  );
}

function isMmbiz(src: string): boolean {
  return /^https?:\/\/mmbiz\.qpic\.cn\//i.test(src);
}

/**
 * Render the layered article (fixed header + body + fixed footer) into one
 * WeChat-ready `<section>` fragment. Deterministic; safe to call on every
 * keystroke (live preview) and again at publish time (single source of truth).
 */
export function renderWechatHtml(input: WechatRenderInput): WechatRenderResult {
  const baseSkin = getWechatSkin(input.skin ?? DEFAULT_WECHAT_SKIN);
  // 用户可调字号：正文/小节标题分别覆盖皮肤默认（clamp 保证微信端可读范围）。
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  const bodyPx = typeof input.bodyFontSize === 'number' && Number.isFinite(input.bodyFontSize)
    ? clamp(input.bodyFontSize, 12, 22)
    : null;
  const headPx = typeof input.headingFontSize === 'number' && Number.isFinite(input.headingFontSize)
    ? clamp(input.headingFontSize, 14, 30)
    : null;
  const skin: WechatSkin = {
    ...baseSkin,
    ...(bodyPx != null ? { bodyFontSize: `${bodyPx}px` } : {}),
    ...(headPx != null ? { h2FontSize: `${headPx}px`, h3FontSize: `${Math.max(headPx - 3, 13)}px` } : {}),
  };
  const notes: string[] = [];
  const localImageSrcs: string[] = [];

  const segments = [input.headerMd ?? '', input.bodyMd ?? '', input.footerMd ?? '']
    .map((s) => (s ?? '').replace(/\r\n/g, '\n'));
  let md = segments.filter((s) => s.trim().length > 0).join('\n\n');

  // Strip ONE leading H1 (the article title never renders into the body).
  const lines = md.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx >= 0 && /^#\s+/.test(lines[firstIdx]!.trim())) {
    lines.splice(firstIdx, 1);
    notes.push('已剥掉正文首行大标题（标题只进草稿的 title 字段）');
  }

  const blocks: string[] = [];
  let i = 0;
  let placeholderCount = 0;

  const flushImage = (src: string, alt: string) => {
    if (!/^https?:\/\//i.test(src)) {
      localImageSrcs.push(src);
    } else if (!isMmbiz(src)) {
      localImageSrcs.push(src);
    }
    blocks.push(
      `<p style="text-align: center;margin: 1.5em 0px;">` +
      `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="max-width: 100%;border-radius: 8px;box-shadow: rgba(0, 0, 0, 0.08) 0px 4px 12px;" />` +
      `</p>`,
    );
  };

  while (i < lines.length) {
    const rawLine = lines[i]!;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.length === 0) { i += 1; continue; }

    // fenced code block
    if (/^```/.test(trimmed)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        buf.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence
      const codeHtml = buf.map((l) => escapeHtml(l)).join('<br/>');
      blocks.push(
        `<p style="margin: 1.2em 0px;background: rgba(0,0,0,0.04);padding: 0.9em 1em;border-radius: 8px;font-family: ${skin.codeFont};font-size: 13px;line-height: 1.75;color: ${skin.textColor};word-break: break-all;">` +
        `<code style="font-family: ${skin.codeFont};">${codeHtml || '&nbsp;'}</code></p>`,
      );
      continue;
    }

    // authoring placeholders: <!-- IMAGE_N: desc --> / <!-- IMAGE_COVER: ... -->
    const marker = trimmed.match(/^<!--\s*IMAGE_([A-Za-z0-9]+)\s*:?([\s\S]*?)-->$/);
    if (marker) {
      if (marker[1]!.toUpperCase() !== 'COVER') placeholderCount += 1;
      i += 1;
      continue;
    }
    // any other HTML comment: drop silently
    if (/^<!--[\s\S]*-->$/.test(trimmed)) { i += 1; continue; }

    // image line ![alt](src)
    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      flushImage(img[2]!, img[1] ?? '');
      i += 1;
      continue;
    }

    // horizontal rule → subtle centered divider (WeChat strips <hr>)
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(`<p style="text-align: center;color: rgba(0,0,0,0.25);margin: 1.6em 0px;letter-spacing: 0.6em;">···</p>`);
      i += 1;
      continue;
    }

    // headings — H1 downgrades to H2 (never emit <h1>)
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const text = renderInline(h[2]!, skin);
      if (level <= 2) {
        if (level === 1) notes.push('正文中的 H1 已降级为小节标题');
        blocks.push(
          renderHeading(text, skin),
        );
      } else {
        blocks.push(
          `<h3 style="margin: 1.6em 0px 0.6em;font-size: ${skin.h3FontSize};font-weight: bold;color: ${headingColorOf(skin)};letter-spacing: ${skin.letterSpacing};font-family: ${skin.headingFont};">${text}</h3>`,
        );
      }
      i += 1;
      continue;
    }

    // blockquote (merge consecutive `>` lines)
    if (/^>\s?/.test(trimmed)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        buf.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      const inner = buf
        .filter((l) => l.trim().length > 0)
        .map((l) => `<p style="margin: 0px;line-height: ${skin.lineHeight};color: #666666;font-size: ${skin.bodyFontSize};">${renderInline(l, skin)}</p>`)
        .join('');
      blocks.push(
        `<blockquote style="padding: 0.5em 1em;border-left: 4px solid ${skin.quoteBorder};background: ${skin.quoteBg};margin: 1.2em 0px;">${inner}</blockquote>`,
      );
      continue;
    }

    // ordered list item → hand-written number in a plain <p> (NEVER <ol>/<li>)
    const ol = trimmed.match(/^(\d+)[.、)]\s+(.*)$/);
    if (ol) {
      blocks.push(
        `<p style="${pStyle(skin)}"><strong style="color: ${skin.titleColor};">${ol[1]}. </strong>${renderInline(ol[2]!, skin)}</p>`,
      );
      i += 1;
      continue;
    }
    // unordered list item → `·` prefix plain <p>
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      blocks.push(
        `<p style="${pStyle(skin)}"><strong style="color: ${skin.titleColor};">· </strong>${renderInline(ul[1]!, skin)}</p>`,
      );
      i += 1;
      continue;
    }

    // plain paragraph — also merge soft-wrapped consecutive text lines
    const buf: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim().length > 0 &&
      !/^(#{1,6}\s|>\s?|```|[-*]\s|\d+[.、)]\s|!\[|<!--|(-{3,}|\*{3,})$)/.test(lines[i]!.trim())
    ) {
      buf.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push(`<p style="${pStyle(skin)}">${buf.map((l) => renderInline(l, skin)).join('<br/>')}</p>`);
  }

  if (placeholderCount > 0) {
    notes.push(`正文有 ${placeholderCount} 个未配图占位（<!-- IMAGE_N -->），已在渲染中隐藏——配图后请用 ![描述](图片地址) 插入`);
  }
  if (localImageSrcs.length > 0) {
    notes.push(`检测到 ${localImageSrcs.length} 张非 mmbiz 图片，发布时会自动上传并替换为微信图床地址`);
  }

  const containerStyle =
    `${skin.bgColor ? `background-color: ${skin.bgColor};` : ''}` +
    `${skin.containerRadius ? `border-radius: ${skin.containerRadius};` : ''}` +
    `${skin.containerShadow ? `box-shadow: ${skin.containerShadow};` : ''}` +
    `padding: 8px 16px;max-width: ${skin.maxWidth};margin: 0px auto;`;

  const html = `<section style="${containerStyle}">${blocks.join('\n')}</section>`;
  return { html, skin: skin.id, notes, localImageSrcs };
}
