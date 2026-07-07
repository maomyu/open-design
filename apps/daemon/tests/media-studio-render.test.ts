// Media Studio deterministic WeChat renderer — the hard rules that used to
// live in prompt text are now code, so they get locked down as specs:
// no H1 in the body, hand-numbered lists (never <ol>/<ul>/<li>), WeChat-safe
// tags only, IMAGE_N placeholders hidden, local img srcs surfaced for the
// publisher to upload+swap. Spec: specs/current/media-studio.md.

import { describe, expect, it } from 'vitest';

import { renderWechatHtml, WECHAT_SKINS } from '../src/media-studio/wechat-render.js';

describe('renderWechatHtml', () => {
  it('strips a leading H1 title and never emits <h1>', () => {
    const r = renderWechatHtml({ bodyMd: '# 大标题\n\n正文第一段。\n\n# 内部一级标题\n\n第二段。' });
    expect(r.html).not.toContain('<h1');
    expect(r.html).not.toContain('大标题');
    // interior H1 downgrades to a section heading instead of vanishing
    expect(r.html).toContain('内部一级标题');
    expect(r.notes.some((n) => n.includes('剥掉'))).toBe(true);
  });

  it('renders lists as hand-numbered <p>, never <ol>/<ul>/<li>', () => {
    const r = renderWechatHtml({ bodyMd: '1. 第一条\n2. 第二条\n- 无序项' });
    expect(r.html).not.toMatch(/<[ou]l|<li/);
    expect(r.html).toContain('1. </strong>第一条');
    expect(r.html).toContain('2. </strong>第二条');
    expect(r.html).toContain('· </strong>无序项');
  });

  it('emits a fully inlined <section> fragment with WeChat-safe tags only', () => {
    const r = renderWechatHtml({
      headerMd: '关注我们,每天一篇干货。',
      bodyMd: '## 小节\n\n正文 **加粗** 与 `代码`。\n\n> 引用一句话\n\n---',
      footerMd: '文末固定结尾。',
    });
    expect(r.html.startsWith('<section')).toBe(true);
    expect(r.html).not.toContain('<style');
    expect(r.html).not.toContain('<head');
    expect(r.html).not.toContain('<body');
    const tags = [...r.html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
    const allowed = new Set(['section', 'p', 'h2', 'h3', 'blockquote', 'strong', 'em', 'span', 'img', 'br', 'a', 'code']);
    for (const t of new Set(tags)) expect(allowed.has(t), `tag <${t}> is not WeChat-safe`).toBe(true);
    // header/body/footer all present, in order
    const iHeader = r.html.indexOf('关注我们');
    const iBody = r.html.indexOf('小节');
    const iFooter = r.html.indexOf('文末固定结尾');
    expect(iHeader).toBeGreaterThan(-1);
    expect(iBody).toBeGreaterThan(iHeader);
    expect(iFooter).toBeGreaterThan(iBody);
  });

  it('hides IMAGE_N placeholders and reports non-mmbiz img srcs for upload', () => {
    const r = renderWechatHtml({
      bodyMd: '<!-- IMAGE_1: 封面草图 -->\n\n![配图](/abs/path/图1.jpg)\n\n![外链](https://example.com/a.png)\n\n![已传](https://mmbiz.qpic.cn/x.jpg)',
    });
    expect(r.html).not.toContain('IMAGE_1');
    expect(r.localImageSrcs).toContain('/abs/path/图1.jpg');
    expect(r.localImageSrcs).toContain('https://example.com/a.png');
    expect(r.localImageSrcs).not.toContain('https://mmbiz.qpic.cn/x.jpg');
    expect(r.notes.some((n) => n.includes('未配图占位'))).toBe(true);
  });

  it('escapes raw HTML in paragraphs', () => {
    const r = renderWechatHtml({ bodyMd: '正文 <script>alert(1)</script> 结束' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('ships kaiti as the single skin and falls back to it for removed ids', () => {
    expect(WECHAT_SKINS.map((s) => s.id)).toEqual(['kaiti']);
    for (const skin of WECHAT_SKINS) {
      const r = renderWechatHtml({ bodyMd: '## 标题\n\n段落', skin: skin.id });
      expect(r.skin).toBe(skin.id);
      expect(r.html).toContain(skin.titleColor);
    }
    // 已移除的皮肤（orangeheart/github/purple）与未知 id 都要稳定兜底 kaiti。
    for (const removed of ['orangeheart', 'github', 'purple', 'nope']) {
      const r = renderWechatHtml({ bodyMd: '段落', skin: removed });
      expect(r.skin).toBe('kaiti');
    }
  });
});
