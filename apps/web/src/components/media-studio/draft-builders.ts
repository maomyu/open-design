// 各创作台「一键填稿」DraftPayload 的共享构建器(2026-07-10 全功能 CLI 化)。
//
// 为什么下沉:构建逻辑原先内联在四个创作台视图里,只有开着视图才能发起
// 注入。CLI 的 handoff 桥(runtime/handoff-listener.ts)要在没有任何视图
// 打开的情况下按文章组稿,所以把构建器抽到这里,视图和监听器共用同一份
// 逻辑——组稿行为永远一致。
//
// 输入只有 (target, article):tags/图集/成片路径全部派生自 article.extra
// (视图内的对应 state 本就是 extra 的镜像),不依赖任何组件状态。
import type { MediaArticle } from '@open-design/contracts';
import type { DraftPayload } from '../../runtime/browser-draft';
import { fetchStudioAssetPaths } from '../../providers/media-studio';

/** 正文清洗(纯文本用途:剪贴板/注入文本段):剥图片标注注释与图片 markdown。 */
export function strippedBodyOf(bodyMd: string): string {
  return bodyMd
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从 AI 结构化脚本里只取【口播脚本】段作为发布正文。AI 写脚本任务产出的是含多小节的 markdown
 * (## 标题备选 / ## 口播脚本 / ## 话题标签 / ## 封面文字),标题备选/标签/封面文字是元信息,
 * 不该进平台正文(2026-07-15 用户报"标题备选出现在正文")。找到口播脚本小节就取其内容;找不到
 * 就剔除已知元信息小节保留其余;完全没有小节结构(纯口播稿)则原样返回。
 */
export function extractSpeechScript(bodyMd: string): string {
  const sections = bodyMd.split(/^(?=#{1,4}[ \t]*\S)/m);
  for (const sec of sections) {
    if (/^#{1,4}[ \t]*(?:口播脚本|口播稿|口播文案|口播文稿|正文脚本)/.test(sec.trimStart())) {
      return sec.replace(/^#{1,4}[ \t]*[^\n]*\n?/, '').trim(); // 去掉小节标题行
    }
  }
  const meta = /^#{1,4}[ \t]*(?:标题备选|备选标题|话题标签|封面文字|封面标题|标签建议|标签)/;
  const joined = sections.filter((sec) => !meta.test(sec.trimStart())).join('').trim();
  return joined || bodyMd.trim();
}

/**
 * 正文转纯文本(存草稿注入用):小红书/抖音/快手/微博/知乎的发布正文框都【不渲染 markdown】,
 * LLM 仿写稿里的 **加粗**、## 标题、`代码`、- 列表、[链接]() 等符号会原样露出、很丑。这里统一
 * 剥成干净纯文本,只保留文字内容与换行,序号列表保留数字(口播要用)。
 * (2026-07-15 用户:自动存草稿的正文不要有 markdown 符号,所有平台同理。)
 */
export function plainTextBody(bodyMd: string): string {
  let s = bodyMd.replace(/<!--[\s\S]*?-->/g, '');          // HTML 注释
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1');       // 围栏代码块 → 保留内容
  s = s.replace(/`([^`\n]+)`/g, '$1');                     // 行内代码
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');              // 图片
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');           // 链接 → 只留文字
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');                // # 标题
  s = s.replace(/^\s{0,3}>\s?/gm, '');                     // > 引用
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1');                 // - 无序列表符号(保留缩进与文字)
  s = s.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, '');        // --- 分隔线
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');               // ***粗斜***
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');                   // **加粗**
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1'); // *斜体*(不误吞 **)
  s = s.replace(/___(.+?)___/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');                       // __加粗__
  s = s.replace(/~~(.+?)~~/g, '$1');                       // ~~删除线~~
  s = s.replace(/\n{3,}/g, '\n\n');                        // 收敛多余空行
  return s.trim();
}

/** 正文按图片位置切成注入段序列(文本段真实键入,图片段原位插入)。 */
export function zhihuSegmentsOf(
  bodyMd: string,
  assetPathByUrl: Map<string, string>,
): Array<{ type: 'text'; text: string } | { type: 'image'; path: string }> {
  const segments: Array<{ type: 'text'; text: string } | { type: 'image'; path: string }> = [];
  const cleanText = (t: string) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyMd)) != null) {
    const text = cleanText(bodyMd.slice(last, m.index));
    if (text.trim()) segments.push({ type: 'text', text });
    const url = (m[1] ?? '').trim();
    const abs = assetPathByUrl.get(url) ?? [...assetPathByUrl.entries()].find(([u]) => url.endsWith(u.split('/').pop() ?? ' '))?.[1];
    if (abs) segments.push({ type: 'image', path: abs });
    last = re.lastIndex;
  }
  const tail = cleanText(bodyMd.slice(last));
  if (tail.trim()) segments.push({ type: 'text', text: tail });
  return segments;
}

/** 正文里引用到的所有资产文章 id(导入的文章图片仍指向源文章目录)。 */
export function assetArticleIdsOf(bodyMd: string, selfId: string): string[] {
  const ids = new Set<string>([selfId]);
  for (const m of bodyMd.matchAll(/\/api\/media-studio\/assets\/([^/]+)\//g)) {
    try {
      ids.add(decodeURIComponent(m[1] ?? ''));
    } catch {
      /* skip broken url */
    }
  }
  return [...ids].filter(Boolean);
}

function splitTags(raw: unknown): string[] {
  return typeof raw === 'string'
    ? raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    : [];
}

/**
 * 按文章所属创作台组装注入稿。返回 null = 稿件没准备好(图集/成片缺失),
 * 调用方给人话提示。target 是要打开的平台面板 id(决定注入器),文章形态
 * (article/images/video)由 article.platform 决定。
 */
export async function buildStudioDraft(target: string, article: MediaArticle): Promise<DraftPayload | null> {
  const extra = (article.extra ?? {}) as Record<string, unknown>;
  switch (article.platform) {
    case 'zhihu': {
      // 图片/封面全自动:正文可能引用导入源文章的资产目录,按 URL 内文章
      // id 合并映射。
      const ids = assetArticleIdsOf(article.bodyMd + '\n' + article.coverSource, article.id);
      const maps = await Promise.all(ids.map((id) => fetchStudioAssetPaths(article.platform, id)));
      const byUrl = new Map(maps.flat().map((a) => [a.url, a.absPath]));
      const coverPath = article.coverSource ? byUrl.get(article.coverSource) : undefined;
      return {
        platform: target,
        kind: 'article',
        title: article.title,
        body: plainTextBody(article.bodyMd),
        tags: [],
        filePaths: [],
        segments: zhihuSegmentsOf(article.bodyMd, byUrl),
        ...(coverPath ? { coverPath } : {}),
      };
    }
    case 'weibo':
      return {
        platform: target,
        kind: 'article',
        title: article.title,
        body: plainTextBody(article.bodyMd),
        tags: [],
        filePaths: [],
      };
    case 'note': {
      // 图集 URL(有序)→本机绝对路径:CDP 注入 file input 用。
      const noteImages = Array.isArray(extra.noteImages)
        ? (extra.noteImages as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      const assets = await fetchStudioAssetPaths(article.platform, article.id);
      const byUrl = new Map(assets.map((a) => [a.url, a.absPath]));
      const filePaths = noteImages
        .map((u) => byUrl.get(u))
        .filter((p): p is string => Boolean(p));
      if (filePaths.length === 0) return null;
      return {
        platform: target,
        kind: 'images',
        title: article.title,
        body: plainTextBody(article.bodyMd),
        tags: splitTags(extra.tags),
        filePaths,
      };
    }
    case 'short-video': {
      const file = typeof extra.videoPath === 'string' ? extra.videoPath.trim() : '';
      // 绝对路径判定必须兼容 win(C:\...):写死 startsWith('/') 在 win 上永假,
      // 视频存草稿会静默 return null(2026-07-19 移植真测时代码审出,与注入桥同款病)。
      if (!/^(?:[a-zA-Z]:[\\/]|\/)/.test(file)) return null;
      // 封面(用户在发布页上传的本机图):带上 → 注入时自动上传到抖音「设置封面」。
      const cover = typeof extra.coverPath === 'string' ? extra.coverPath.trim() : '';
      return {
        platform: target,
        kind: 'video',
        title: article.title,
        // 只取【口播脚本】段(剔除标题备选/标签/封面文字元信息小节)再去 markdown 符号。
        body: plainTextBody(extractSpeechScript(article.bodyMd)),
        tags: splitTags(extra.tags),
        filePaths: [file],
        ...(/^(?:[a-zA-Z]:[\\/]|\/)/.test(cover) ? { coverPath: cover } : {}),
      };
    }
    default:
      return null;
  }
}
