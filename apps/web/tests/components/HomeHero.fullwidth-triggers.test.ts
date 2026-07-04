// @vitest-environment jsdom
//
// Red spec for「Windows 打包版 @ / 呼不出插件」: Windows/中文输入法在中文
// 标点模式下敲出的是全角 ＠ ／ ＃,半角-only 的触发正则会静默不开选择器。
// getContextMention 必须把全角触发符归一化为半角 trigger,query 照常提取。

import { describe, expect, it } from 'vitest';
import { getContextMention } from '../../src/components/HomeHero';

describe('getContextMention full-width IME triggers', () => {
  it('opens the mention picker on full-width ＠ and normalizes the trigger', () => {
    const m = getContextMention('帮我写文案 ＠公众');
    expect(m).not.toBeNull();
    expect(m!.trigger).toBe('@');
    expect(m!.query).toBe('公众');
  });

  it('opens the slash picker on full-width ／ at word start', () => {
    const m = getContextMention('／短视');
    expect(m).not.toBeNull();
    expect(m!.trigger).toBe('/');
    expect(m!.query).toBe('短视');
  });

  it('opens the type picker on full-width ＃', () => {
    const m = getContextMention('＃');
    expect(m).not.toBeNull();
    expect(m!.trigger).toBe('#');
    expect(m!.query).toBe('');
  });

  it('still handles half-width triggers unchanged', () => {
    expect(getContextMention('hello @plu')?.trigger).toBe('@');
    expect(getContextMention('/dep')?.trigger).toBe('/');
  });

  it('does not fire mid-word (no leading whitespace)', () => {
    expect(getContextMention('email＠example')).toBeNull();
  });
});
