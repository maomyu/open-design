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
  const bodyHtml = renderBody(opts.bodyMd);
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
