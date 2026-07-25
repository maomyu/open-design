// 「撞风控就整批停」安全闸的契约(见 src/media-studio/interaction-freeze.ts)。
// 这条语义决定【风控后还会不会继续自动外发】——继续发只会加速封号,所以行为必须锁死:
// 触发风控 → 该 平台×账号 当天冻结 → 后续每条外发前查到冻结就整批停;跨天(次日 0 点)自动解冻。
import { describe, expect, it } from 'vitest';
import { createAutoSendFreeze, endOfLocalDay } from '../src/media-studio/interaction-freeze.js';

// 固定时刻(+8 时区某天 10:00),不用 Date.now,断言稳定。
const T0 = Date.UTC(2026, 6, 25, 2, 0, 0); // 2026-07-25 10:00 (UTC+8)

describe('createAutoSendFreeze — 风控冻结台账', () => {
  it('未冻结时默认放行', () => {
    const f = createAutoSendFreeze();
    expect(f.isFrozen('xiaohongshu', 'main', T0)).toBe(false);
  });

  it('触发风控后,当天整段都冻结(同账号后续每条都被拦)', () => {
    const f = createAutoSendFreeze();
    f.freeze('xiaohongshu', 'main', T0);
    expect(f.isFrozen('xiaohongshu', 'main', T0)).toBe(true);
    expect(f.isFrozen('xiaohongshu', 'main', T0 + 6 * 3_600_000)).toBe(true); // 6 小时后仍冻着
  });

  it('只冻结命中的 平台×账号,不误伤别的账号/平台', () => {
    const f = createAutoSendFreeze();
    f.freeze('xiaohongshu', 'main', T0);
    expect(f.isFrozen('xiaohongshu', 'other', T0)).toBe(false);
    expect(f.isFrozen('weibo', 'main', T0)).toBe(false);
  });

  it('跨到次日(本地 0 点后)自动解冻', () => {
    const f = createAutoSendFreeze();
    f.freeze('xiaohongshu', 'main', T0);
    const nextDay = endOfLocalDay(T0) + 60_000; // 次日 0 点再过 1 分钟
    expect(f.isFrozen('xiaohongshu', 'main', nextDay)).toBe(false);
  });

  it('account=null(默认账号)也能独立冻结', () => {
    const f = createAutoSendFreeze();
    f.freeze('xiaohongshu', null, T0);
    expect(f.isFrozen('xiaohongshu', null, T0)).toBe(true);
    expect(f.isFrozen('xiaohongshu', 'main', T0)).toBe(false);
  });

  it('用户人工完成验证后可手动解冻(只解命中的 平台×账号)', () => {
    const f = createAutoSendFreeze();
    f.freeze('xiaohongshu', 'main', T0);
    f.freeze('weibo', 'main', T0);
    f.unfreeze('xiaohongshu', 'main');
    expect(f.isFrozen('xiaohongshu', 'main', T0)).toBe(false);
    expect(f.isFrozen('weibo', 'main', T0)).toBe(true); // 别的平台的冻结不受影响
    f.unfreeze('xiaohongshu', 'other'); // 解一个本来没冻的,不炸也不影响别人
    expect(f.isFrozen('weibo', 'main', T0)).toBe(true);
  });
});

describe('endOfLocalDay — 本地当天结束(次日 0 点)', () => {
  it('+8 时区:当天任意时刻都落到同一个次日 0 点', () => {
    const morning = Date.UTC(2026, 6, 25, 2, 0, 0); // 07-25 10:00 (+8)
    const evening = Date.UTC(2026, 6, 25, 15, 30, 0); // 07-25 23:30 (+8)
    expect(endOfLocalDay(morning)).toBe(endOfLocalDay(evening));
    // 次日 0:00(+8)= UTC 前一日 16:00。
    expect(endOfLocalDay(morning)).toBe(Date.UTC(2026, 6, 25, 16, 0, 0));
  });
});
