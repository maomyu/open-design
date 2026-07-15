// 知乎文章预览渲染(2026-07-10 用户拍板:按知乎实际发布样式,不套公众号)。
//
// 知乎文章页的视觉特征(对照 zhuanlan.zhihu.com 文章页):
//  - 宽正文栏(690px 内容区,非手机窄栏),白底
//  - 标题:36px 粗体黑;正文:16px、行高 1.7、#1a1a1a、思源/系统无衬线
//  - 封面横图置顶(16:9,圆角);正文配图居中、圆角、带下间距
//  - 二级标题加粗略大;引用左竖条浅灰底;链接知乎蓝 #175199
//  - 话题标签(文末)蓝色胶囊
// 纯前端 markdown→HTML(不经公众号 renderWechatHtml 端点),轻量子集足够
// 预览(标题/段落/列表/引用/图片/加粗/链接)。

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 行内 markdown:加粗/斜体/行内代码/链接(先转义再放行这几类)。 */
function inline(md: string): string {
  let s = esc(md);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 行内图单独处理,这里剔除
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/** markdown → 知乎 DraftJS 可粘贴的 HTML 片段(标题/段落/列表/引用/加粗/
 *  链接;图片剔除——本地图片走 CDP 单独插入)。发布注入用。
 *  知乎专栏正文标题只有一级(编辑器「标题」=h2),所以 #/##/### 统一压成
 *  h2(实测 h2 被 DraftJS 解析,h3/h4 样式对不上)。 */
export function markdownToZhihuHtml(md: string): string {
  return renderBody(md.replace(/!\[[^\]]*\]\([^)]*\)/g, '')).replace(/<(\/?)h[34]>/g, '<$1h2>');
}

/** markdown → 知乎版式 HTML 片段。图片单独成块(居中圆角)。 */
function renderBody(md: string): string {
  const clean = md.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: string[] = [];
  const lines = clean.split('\n');
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const imgM = line.match(/^!\[[^\]]*\]\(([^)]+)\)\s*$/);
    if (imgM) {
      flushPara();
      flushList();
      blocks.push(`<figure><img src="${esc(imgM[1] ?? '')}" alt=""/></figure>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min((h[1] ?? '#').length + 1, 4); // # → h2(知乎正文不用 h1)
      blocks.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      blocks.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      list.push(li[1] ?? '');
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks.join('\n');
}

/** 完整知乎预览文档(iframe srcDoc)。 */
export function zhihuPreviewDoc(opts: { title: string; bodyMd: string; coverUrl?: string; tags?: string[] }): string {
  // 预览标题层级与实际发布对齐:知乎正文标题统一 h2(见 markdownToZhihuHtml)。
  const bodyHtml = renderBody(opts.bodyMd).replace(/<(\/?)h[34]>/g, '<$1h2>');
  const cover = opts.coverUrl
    ? `<div class="cover"><img src="${esc(opts.coverUrl)}" alt=""/></div>`
    : '';
  const tags = (opts.tags ?? []).filter(Boolean);
  const tagBar = tags.length
    ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:light;}
  body{margin:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Source Han Sans SC',sans-serif;}
  .page{max-width:690px;margin:0 auto;background:#fff;min-height:100vh;padding:28px 24px 60px;box-sizing:border-box;}
  .cover{margin:0 0 24px;}
  .cover img{width:100%;border-radius:6px;display:block;}
  h1.__title{font-size:30px;line-height:1.4;font-weight:700;color:#1a1a1a;margin:0 0 20px;}
  .content{font-size:16px;line-height:1.8;color:#1a1a1a;}
  .content p{margin:0 0 20px;}
  .content h2{font-size:22px;font-weight:600;color:#1a1a1a;margin:32px 0 14px;}
  .content h3{font-size:18px;font-weight:600;color:#1a1a1a;margin:26px 0 12px;}
  .content h4{font-size:16px;font-weight:600;margin:22px 0 10px;}
  .content figure{margin:24px 0;text-align:center;}
  .content figure img{max-width:100%;border-radius:6px;display:inline-block;}
  .content blockquote{margin:20px 0;padding:12px 16px;background:#f6f6f6;border-left:4px solid #d0d0d0;color:#646464;border-radius:2px;}
  .content ul{margin:0 0 20px;padding-left:24px;}
  .content li{margin:8px 0;}
  .content a{color:#175199;text-decoration:none;}
  .content code{background:#f6f6f6;border-radius:3px;padding:1px 5px;font-size:14px;font-family:ui-monospace,Menlo,monospace;}
  .content strong{font-weight:600;}
  .tags{margin-top:36px;display:flex;flex-wrap:wrap;gap:8px;}
  .tag{background:#eef2f8;color:#175199;font-size:13px;padding:5px 12px;border-radius:999px;}
  </style></head><body><div class="page">
  ${cover}
  ${opts.title ? `<h1 class="__title">${esc(opts.title)}</h1>` : ''}
  <div class="content">${bodyHtml}</div>
  ${tagBar}
  </div></body></html>`;
}

/** 微博预览:微博发布卡样式(2026-07-10 用户报缺预览)。正文纯文本(微博
 *  发布框不支持富文本),#话题# 蓝色,图片方格。标题并进正文首行(微博
 *  普通微博无独立标题)。 */
export function weiboPreviewDoc(opts: { title: string; bodyMd: string; imageUrls?: string[]; tags?: string[] }): string {
  const plain = opts.bodyMd
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[#*>`]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const titleLine = opts.title ? `${esc(opts.title)}\n` : '';
  const tagText = (opts.tags ?? []).filter(Boolean).map((t) => `#${esc(t)}#`).join(' ');
  // 正文里的话题词着色(#词#)。
  const bodyText = esc(titleLine + plain).replace(/#([^#\n]{1,20})#/g, '<span class="tp">#$1#</span>');
  const imgs = (opts.imageUrls ?? []).filter(Boolean);
  const imgGrid = imgs.length
    ? `<div class="imgs">${imgs.slice(0, 9).map((u) => `<div class="cell"><img src="${esc(u)}" alt=""/></div>`).join('')}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#f2f2f5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;}
  .card{max-width:480px;margin:16px auto;background:#fff;border-radius:8px;padding:18px 16px;}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
  .avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#ff8200,#ffb300);}
  .name{font-size:15px;font-weight:600;color:#f6641e;}
  .meta{font-size:12px;color:#999;}
  .text{font-size:16px;line-height:1.7;color:#1a1a1a;white-space:pre-wrap;word-break:break-word;}
  .tp{color:#eb7350;}
  .imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:12px;}
  .cell{aspect-ratio:1;overflow:hidden;border-radius:4px;background:#f2f2f5;}
  .cell img{width:100%;height:100%;object-fit:cover;display:block;}
  ${tagText ? '' : ''}
  </style></head><body>
  <div class="card">
    <div class="head"><div class="avatar"></div><div><div class="name">微博用户</div><div class="meta">刚刚 · 来自 爆创</div></div></div>
    <div class="text">${bodyText}${tagText ? ` <span class="tp">${tagText}</span>` : ''}</div>
    ${imgGrid}
  </div></body></html>`;
}
