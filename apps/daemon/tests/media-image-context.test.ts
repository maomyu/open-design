// 配图段落上下文提取(2026-07-20 用户反馈"公众号配图与所在段落无关"):
// 按 <!-- IMAGE_N --> 标注位置取上一个正文段落,生图提示词以此锚定段落内容。
import { describe, expect, it } from 'vitest';

import { composeImagePrompt, imageMarkerContext, stripNoTextClauses } from '../src/media-studio/image-context.js';
import { styleAllowsText } from '../src/media-studio/qwen-image.js';

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

describe('composeImagePrompt', () => {
  it('passes description through untouched when there is no paragraph context', () => {
    expect(composeImagePrompt('一只手插社保卡', {})).toBe('一只手插社保卡');
    expect(composeImagePrompt('一只手插社保卡', { context: '  ', articleTitle: '标题' })).toBe('一只手插社保卡');
  });

  it('builds a structured storyboard prompt with theme, paragraph anchor and requirements', () => {
    const p = composeImagePrompt('一只手把社保卡插回读卡器', {
      context: '所在小节:断缴的代价。社保断缴后购房资格清零',
      articleTitle: '社保断缴的五个坑',
    });
    expect(p).toContain('主画面:一只手把社保卡插回读卡器');
    expect(p).toContain('文章主题:《社保断缴的五个坑》');
    expect(p).toContain('所配段落');
    expect(p).toContain('社保断缴后购房资格清零');
    expect(p).toContain('画面要求');
    expect(p).toContain('不要出现任何可读文字');
  });

  it('drops the no-text clause for text-allowed styles (bigtext)', () => {
    const p = composeImagePrompt('大字标题:断缴警告', { context: '段落内容', allowText: true });
    expect(p).toContain('主画面:大字标题:断缴警告');
    expect(p).not.toContain('不要出现任何可读文字');
  });
});

describe('stripNoTextClauses (允字风格剥掉老稿描述里的禁字句)', () => {
  it('removes trailing no-text clauses AI baked into old descriptions', () => {
    // 2026-07-20 用户实测的真实样例。
    expect(stripNoTextClauses('牛皮纸手账页贴两张纸条,平铺柔光,画面不含任何可读文字')).toBe('牛皮纸手账页贴两张纸条,平铺柔光');
    expect(stripNoTextClauses('配色以牛皮黄为主,平铺柔光如扫描页面,干净克制不含任何文字')).toBe('配色以牛皮黄为主,平铺柔光如扫描页面');
    expect(stripNoTextClauses('拼贴风,画面不要出现文字,暖色调')).toBe('拼贴风,暖色调');
  });

  it('keeps descriptions without ban clauses untouched', () => {
    expect(stripNoTextClauses('手账页上有手写短词「加油」和贴纸')).toBe('手账页上有手写短词「加油」和贴纸');
  });

  it('composeImagePrompt strips the clause when allowText, keeps it otherwise', () => {
    const withBan = '手账拼贴,画面不含任何可读文字';
    expect(composeImagePrompt(withBan, { context: '段落', allowText: true })).not.toContain('不含任何可读文字');
    expect(composeImagePrompt(withBan, { context: '段落', allowText: false })).toContain('不含任何可读文字');
    // 无段落上下文时也剥(封面/重生成路径)。
    expect(composeImagePrompt(withBan, { allowText: true })).toBe('手账拼贴');
  });
});

describe('styleAllowsText (与引擎风格负面词同一份口径)', () => {
  it('allows text for whiteboard/bigtext/journal/none, bans for noText presets', () => {
    // 允字:手写/图解/标题是这些风格的精髓(2026-07-20 用户报手账被误禁字)。
    expect(styleAllowsText('journal')).toBe(true);
    expect(styleAllowsText('bigtext')).toBe(true);
    expect(styleAllowsText('whiteboard')).toBe(true);
    expect(styleAllowsText('none')).toBe(true);
    expect(styleAllowsText(undefined)).toBe(true); // 引擎缺省=whiteboard
    // 禁字:摄影/插画类,模型写中文易乱码。
    expect(styleAllowsText('photo-film')).toBe(false);
    expect(styleAllowsText('watercolor')).toBe(false);
    expect(styleAllowsText('cute')).toBe(false);
    expect(styleAllowsText('clean')).toBe(false);
  });
});
