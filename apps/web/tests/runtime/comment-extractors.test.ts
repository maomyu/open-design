// 评论树提取器的纯 helper 契约（提取器 IIFE 本身对真实页面另行真机验证）。
import { describe, expect, it } from 'vitest';
import { parseCount, buildNoteUrl } from '../../src/runtime/comment-extractors';

describe('parseCount', () => {
  it('中文万/亿单位', () => {
    expect(parseCount('1.2万')).toBe(12_000);
    expect(parseCount('3.4w')).toBe(34_000);
    expect(parseCount('2W')).toBe(20_000);
    expect(parseCount('1亿')).toBe(100_000_000);
  });
  it('纯数字与逗号', () => {
    expect(parseCount('1234')).toBe(1234);
    expect(parseCount('1,234')).toBe(1); // 逗号后截断（小红书不用千分位，取首段数字即可）
    expect(parseCount('99+')).toBe(99);
  });
  it('非数字/空/文案归零', () => {
    expect(parseCount('赞')).toBe(0);
    expect(parseCount('点赞')).toBe(0);
    expect(parseCount('')).toBe(0);
    expect(parseCount(null)).toBe(0);
    expect(parseCount(undefined)).toBe(0);
  });
});

describe('buildNoteUrl', () => {
  it('已是链接则原样返回', () => {
    const u = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=x';
    expect(buildNoteUrl('xiaohongshu', u)).toBe(u);
  });
  it('note id 拼小红书笔记页', () => {
    expect(buildNoteUrl('xiaohongshu', 'abc123')).toBe('https://www.xiaohongshu.com/explore/abc123');
  });
  it('空返回空', () => {
    expect(buildNoteUrl('xiaohongshu', '')).toBe('');
  });
});
