// 配图段落上下文提取(2026-07-20 用户反馈"公众号配图与所在段落无关"):
// 按 <!-- IMAGE_N --> 标注位置取上一个正文段落,生图提示词以此锚定段落内容。
import { describe, expect, it } from 'vitest';

import { imageMarkerContext } from '../src/media-studio/image-context.js';

describe('imageMarkerContext', () => {
  it('returns the paragraph right above the marker, markdown stripped', () => {
    const body = [
      '导语一句话。',
      '',
      '## 断缴的代价',
      '',
      '社保**断缴**后，[购房资格](https://x)会被清零，`连续缴纳` 年限重新计算。',
      '',
      '<!-- IMAGE_1: 社保卡, 4:3 -->',
    ].join('\n');
    const ctx = imageMarkerContext(body, '1');
    expect(ctx).toContain('社保断缴后，购房资格会被清零');
    expect(ctx).not.toContain('**');
    expect(ctx).not.toContain('[');
  });

  it('uses the section heading + the paragraph BELOW when marker sits right after a heading', () => {
    const body = [
      '上一小节的收尾段。',
      '',
      '## 三个补救办法',
      '',
      '<!-- IMAGE_2: 补救, 4:3 -->',
      '',
      '第一个办法是补缴：带上身份证去社保局窗口办理。',
    ].join('\n');
    const ctx = imageMarkerContext(body, '2');
    expect(ctx).toContain('所在小节:三个补救办法');
    // 贴合的是本小节内容,不是上一小节的收尾。
    expect(ctx).toContain('第一个办法是补缴');
    expect(ctx).not.toContain('上一小节的收尾段');
  });

  it('skips other markers and inserted images when looking for the paragraph', () => {
    const body = [
      '真正相关的段落。',
      '',
      '<!-- IMAGE_1: 前一张, 4:3 -->',
      '',
      '![配图](/api/media-studio/assets/a/b.jpg)',
      '',
      '<!-- IMAGE_2: 这张, 4:3 -->',
    ].join('\n');
    expect(imageMarkerContext(body, '2')).toContain('真正相关的段落');
  });

  it('clips long paragraphs to keep the image prompt bounded', () => {
    const body = `${'长'.repeat(500)}\n\n<!-- IMAGE_1: x, 4:3 -->`;
    const ctx = imageMarkerContext(body, '1')!;
    expect(ctx.length).toBeLessThan(260);
    expect(ctx.endsWith('…')).toBe(true);
  });

  it('supports full-width colon in markers', () => {
    const body = '段落。\n\n<!-- IMAGE_3： 描述, 4:3 -->';
    expect(imageMarkerContext(body, '3')).toContain('段落');
  });

  it('returns null when marker missing or nothing precedes it (cover at top)', () => {
    expect(imageMarkerContext('没有标注的正文', '1')).toBeNull();
    expect(imageMarkerContext('<!-- IMAGE_COVER: 封面, 16:9 -->\n\n正文', 'COVER')).toBeNull();
  });
});
