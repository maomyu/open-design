// 互动风控台账的行为契约（合同一④「操作限流/养号节奏」的底座）。
// 纯决策(decideQuota)与库层原子认领(claimInteractionSlot)分开测：前者判每种拦截，
// 后者验「查—判—记」在事务里不被并发穿透 + 跨天重置 + 审计留痕。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db.js';
import {
  claimInteractionSlot,
  listInteractions,
  peekInteractionQuota,
  recordInteraction,
} from '../src/media-studio/store.js';
import {
  decideQuota,
  inQuietHours,
  type InteractionPolicy,
} from '../src/media-studio/interaction-quota.js';

const POLICY: InteractionPolicy = { dailyCap: 3, cooldownMs: 30_000, quietHours: null, tzOffsetMinutes: 480 };
// 2026-01-01 12:00:00 UTC+8 起步（远离零点/静默，避免边界干扰）。
const T0 = Date.UTC(2026, 0, 1, 4, 0, 0); // 04:00 UTC = 12:00 UTC+8

describe('decideQuota（纯决策）', () => {
  it('空状态放行', () => {
    const d = decideQuota(null, POLICY, T0);
    expect(d.allowed).toBe(true);
    expect(d.usedToday).toBe(0);
  });

  it('达单日上限拦截 daily-cap', () => {
    const d = decideQuota({ day: Math.floor((T0 + 480 * 60_000) / 86_400_000), count: 3, lastActionAt: 0 }, POLICY, T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('daily-cap');
  });

  it('冷却窗内拦截 cooldown 并回传 retryAfterMs', () => {
    const d = decideQuota({ day: Math.floor((T0 + 480 * 60_000) / 86_400_000), count: 1, lastActionAt: T0 - 10_000 }, POLICY, T0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('cooldown');
    expect(d.retryAfterMs).toBe(20_000);
  });

  it('静默时段最高优先级拦截 quiet-hours', () => {
    const quiet: InteractionPolicy = { ...POLICY, quietHours: { start: 1, end: 7 } };
    const at2am = Date.UTC(2026, 0, 1, 18, 0, 0); // 18:00 UTC = 次日 02:00 UTC+8
    const d = decideQuota(null, quiet, at2am);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('quiet-hours');
  });

  it('跨天计数归零后放行（旧 count 属昨天）', () => {
    const yesterday = Math.floor((T0 + 480 * 60_000) / 86_400_000) - 1;
    const d = decideQuota({ day: yesterday, count: 3, lastActionAt: T0 - 86_400_000 }, POLICY, T0);
    expect(d.allowed).toBe(true);
    expect(d.usedToday).toBe(0);
  });
});

describe('inQuietHours（跨零点）', () => {
  it('22:00–06:00 区间：凌晨 2 点命中、下午 3 点不命中', () => {
    expect(inQuietHours(2, { start: 22, end: 6 })).toBe(true);
    expect(inQuietHours(23, { start: 22, end: 6 })).toBe(true);
    expect(inQuietHours(15, { start: 22, end: 6 })).toBe(false);
  });
  it('空区间不拦', () => {
    expect(inQuietHours(5, { start: 5, end: 5 })).toBe(false);
    expect(inQuietHours(5, null)).toBe(false);
  });
});

describe('claimInteractionSlot（库层原子认领）', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iquota-'));
    db = openDatabase(dir);
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次放行并占名额；同刻第二次被冷却拦（并发只放行一个）', () => {
    const first = claimInteractionSlot(db, 'xiaohongshu', 'acctA', POLICY, T0);
    expect(first.allowed).toBe(true);
    expect(first.usedToday).toBe(1);
    // 同一时刻再来 → 距上次 0ms < 冷却，拦。
    const second = claimInteractionSlot(db, 'xiaohongshu', 'acctA', POLICY, T0);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('cooldown');
  });

  it('冷却过后可继续，直到当日上限拦截', () => {
    let t = T0;
    expect(claimInteractionSlot(db, 'xiaohongshu', 'acctB', POLICY, t).allowed).toBe(true); // 1
    t += 31_000;
    expect(claimInteractionSlot(db, 'xiaohongshu', 'acctB', POLICY, t).allowed).toBe(true); // 2
    t += 31_000;
    expect(claimInteractionSlot(db, 'xiaohongshu', 'acctB', POLICY, t).allowed).toBe(true); // 3 (= cap)
    t += 31_000;
    const capped = claimInteractionSlot(db, 'xiaohongshu', 'acctB', POLICY, t);
    expect(capped.allowed).toBe(false);
    expect(capped.reason).toBe('daily-cap');
  });

  it('跨天后名额重置', () => {
    let t = T0;
    for (let i = 0; i < 3; i++) { claimInteractionSlot(db, 'xiaohongshu', 'acctC', POLICY, t); t += 31_000; }
    expect(claimInteractionSlot(db, 'xiaohongshu', 'acctC', POLICY, t).reason).toBe('daily-cap');
    const nextDay = T0 + 86_400_000;
    const after = claimInteractionSlot(db, 'xiaohongshu', 'acctC', POLICY, nextDay);
    expect(after.allowed).toBe(true);
    expect(after.usedToday).toBe(1);
  });

  it('不同账号名额互不影响；无账号(null)独立成一桶', () => {
    expect(claimInteractionSlot(db, 'xiaohongshu', 'x', POLICY, T0).allowed).toBe(true);
    expect(claimInteractionSlot(db, 'xiaohongshu', 'y', POLICY, T0).allowed).toBe(true);
    expect(claimInteractionSlot(db, 'xiaohongshu', null, POLICY, T0).allowed).toBe(true);
    // x 再来被冷却，但 y、null 不受影响（各自独立）。
    expect(claimInteractionSlot(db, 'xiaohongshu', 'x', POLICY, T0).allowed).toBe(false);
  });

  it('peek 只读判定不占名额', () => {
    const peek = peekInteractionQuota(db, 'weibo', 'acctD', POLICY, T0);
    expect(peek.allowed).toBe(true);
    // peek 不落库 → 真正认领仍是「首次」。
    expect(claimInteractionSlot(db, 'weibo', 'acctD', POLICY, T0).usedToday).toBe(1);
  });
});

describe('recordInteraction / listInteractions（审计留痕）', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iaudit-'));
    db = openDatabase(dir);
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('外发成功与被拦都留痕，按账号可查、倒序', () => {
    recordInteraction(db, { platform: 'xiaohongshu', accountId: 'a', action: 'reply', targetRef: 'note1', text: '谢谢支持', status: 'done', at: T0 });
    recordInteraction(db, { platform: 'xiaohongshu', accountId: 'a', action: 'dm', targetRef: 'user9', text: '私信你了', status: 'blocked', detail: 'cooldown', at: T0 + 1000 });
    const rows = listInteractions(db, { platform: 'xiaohongshu', accountId: 'a' });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('blocked'); // 倒序，最新在前
    expect(rows[0]?.detail).toBe('cooldown');
    expect(rows[1]?.action).toBe('reply');
  });
});
