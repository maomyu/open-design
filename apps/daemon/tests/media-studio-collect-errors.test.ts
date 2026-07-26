/**
 * Field report (customer Windows laptop, 2026-07-26): 抓爆款采集 returned
 * an empty list for days. The engine log had the answer all along —
 * `采集失败 xiaohongshu: RetryError[... HTTPError]`, TikHub answering 401
 * to every request because the customer's token had expired — but the
 * route swallowed it and handed the UI a bare `count: 0`, which reads
 * exactly like "this keyword has no hits". The customer kept changing
 * keywords.
 *
 * These specs pin the translation from a machine-shaped failure to an
 * instruction: which key, where to fix it, and — for the cases the user
 * can't fix — that retrying is the right move.
 */

import { describe, expect, it } from 'vitest';

import { describeCollectFailure } from '../src/media-studio/collect-errors.js';

describe('describeCollectFailure', () => {
  it('returns null when nothing failed, so a genuinely empty result stays "0 条"', () => {
    expect(describeCollectFailure([])).toBeNull();
    expect(describeCollectFailure(undefined)).toBeNull();
    expect(describeCollectFailure(null)).toBeNull();
  });

  it('names the expired token and where to replace it on 401', () => {
    const msg = describeCollectFailure([
      { platform: 'xiaohongshu', status: 401, reason: 'HTTP 401' },
    ]);
    expect(msg).toContain('小红书');
    expect(msg).toContain('TikHub');
    expect(msg).toContain('401');
    expect(msg).toContain('设置 → 接口与密钥');
    // The whole point: deny the "没有爆款" reading the empty list invites.
    expect(msg).toContain('没有爆款');
  });

  it('treats 403 like 401 — both mean the source refused the token', () => {
    const msg = describeCollectFailure([{ platform: 'douyin', status: 403, reason: 'HTTP 403' }]);
    expect(msg).toContain('抖音');
    expect(msg).toContain('403');
    expect(msg).toContain('设置 → 接口与密钥');
  });

  it('points at billing on 402 rather than at the key', () => {
    const msg = describeCollectFailure([{ platform: 'douyin', status: 402, reason: 'HTTP 402' }]);
    expect(msg).toContain('402');
    expect(msg).toContain('额度');
    expect(msg).not.toContain('设置 → 接口与密钥');
  });

  it('tells the user to wait on 429 instead of touching config', () => {
    const msg = describeCollectFailure([{ platform: 'kuaishou', status: 429, reason: 'HTTP 429' }]);
    expect(msg).toContain('429');
    expect(msg).toContain('限流');
    expect(msg).not.toContain('设置 → 接口与密钥');
  });

  it('marks 5xx as the upstream wobbling, not a misconfiguration', () => {
    const msg = describeCollectFailure([{ platform: 'bilibili', status: 503, reason: 'HTTP 503' }]);
    expect(msg).toContain('503');
    expect(msg).toContain('不用改配置');
  });

  it('credits 视频号 to 极致数据, not TikHub — they are different accounts', () => {
    const msg = describeCollectFailure([{ platform: 'channels', status: 401, reason: 'HTTP 401' }]);
    expect(msg).toContain('视频号');
    expect(msg).toContain('极致数据');
    expect(msg).not.toContain('TikHub');
  });

  it('falls back to the raw reason when no HTTP status was recovered', () => {
    const msg = describeCollectFailure([
      { platform: 'xiaohongshu', status: null, reason: 'ConnectionError: dns failure' },
    ]);
    expect(msg).toContain('ConnectionError: dns failure');
    expect(msg).toContain('没有爆款');
  });

  it('lists every failing platform when a multi-platform run dies wholesale', () => {
    const msg = describeCollectFailure([
      { platform: 'xiaohongshu', status: 401, reason: 'HTTP 401' },
      { platform: 'douyin', status: 401, reason: 'HTTP 401' },
    ]);
    expect(msg).toContain('小红书');
    expect(msg).toContain('抖音');
  });

  it('ignores malformed entries instead of throwing', () => {
    expect(describeCollectFailure(['nope', 42])).toBeNull();
    expect(describeCollectFailure([{}])).toContain('采集失败');
  });
});
