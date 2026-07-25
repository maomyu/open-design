// kimi CLI 一发模式路由契约(2026-07-23「无法评论」事故的第三环):
// agentId=kimi 时 callModelOnce 必须走【本机 kimi CLI 一发】(transport=chat-cli),
// 绝不许跌去借 hermes/codex 的 ChatGPT OAuth token 打 api.openai.com——
// 那条路要么 401 token_expired、要么 429 insufficient_quota,互动区 AI 拟稿必挂。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callModelOnce } from '../src/memory-llm.js';

describe('callModelOnce — kimi 本地 CLI 路由', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('agentId=kimi 走本机 CLI 一发,不借 OAuth/HTTP provider', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'od-memory-llm-kimi-'));
    const calls: Array<{ agentId?: string }> = [];
    const out = await callModelOnce(dir, {
      projectRoot: dir,
      chatAgentId: 'kimi',
      system: 's',
      user: 'u',
      localCliRunner: async (args: { agentId?: string }) => {
        calls.push(args);
        return '{"results":[]}';
      },
    });
    expect(out).toBe('{"results":[]}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentId).toBe('kimi');
  });

  it('agentId=kimi 且本机 CLI 抛错时,错误如实上抛(不静默降级)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'od-memory-llm-kimi-'));
    await expect(
      callModelOnce(dir, {
        projectRoot: dir,
        chatAgentId: 'kimi',
        system: 's',
        user: 'u',
        localCliRunner: async () => {
          throw new Error('kimi CLI exit 1: boom');
        },
      }),
    ).rejects.toThrow('kimi CLI exit 1');
  });
});
