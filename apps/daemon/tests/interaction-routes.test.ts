// 互动路由的集成契约:桌面未连拒建(不耗配额)、订阅后可建、风控台账在路由层拦截并落
// blocked 审计、complete 落 done/error 审计。风控策略默认单日上限较大,这里通过快速连发
// 触发冷却拦截来验证「路由层真的过了台账」。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerMediaStudioRoutes } from '../src/media-studio-routes.js';

describe('interaction routes', () => {
  let tempDir: string;
  let server: ReturnType<express.Express['listen']>;
  let base: string;

  async function start() {
    const app = express();
    app.use(express.json());
    const db = openDatabase(tempDir, { dataDir: tempDir });
    registerMediaStudioRoutes(app, {
      db,
      paths: { RUNTIME_DATA_DIR: tempDir, PROJECT_ROOT: tempDir },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  }

  // 开一条 SSE 连接当「桌面端订阅者」,让 bus 认为桌面在线。返回关闭器。
  async function subscribe(): Promise<() => void> {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}/api/media-studio/interaction/events`, { signal: ctrl.signal });
    // 读到首帧(': connected')确保订阅已注册。
    const reader = resp.body!.getReader();
    await reader.read();
    return () => { try { ctrl.abort(); } catch { /* ignore */ } reader.cancel().catch(() => {}); };
  }

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  type AuditRow = { status: string; detail: string | null; targetRef: string };
  type Body = {
    job?: { id: string; status: string } | null;
    blocked?: { reason: string; retryAfterMs?: number };
    items?: AuditRow[];
    allowed?: boolean;
    usedToday?: number;
  };
  const jpost = async (p: string, body: unknown): Promise<Body> => (await post(p, body)).json() as Promise<Body>;
  const jget = async (p: string): Promise<Body> => (await fetch(`${base}${p}`)).json() as Promise<Body>;

  const REQ = { platform: 'xiaohongshu', account: 'acctA', action: 'reply', targetRef: 'note1', text: '谢谢～' };

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'ix-routes-'));
    await start();
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('桌面端未连接 → 409,且不消耗配额（订阅后首发仍算第一次）', async () => {
    const off = await post('/api/media-studio/interaction', REQ);
    expect(off.status).toBe(409);
    // 审计里不应有 blocked 记录（根本没进台账）。
    const audit = await jget('/api/media-studio/interactions');
    expect(audit.items).toHaveLength(0);

    const close = await subscribe();
    const okBody = await jpost('/api/media-studio/interaction', REQ);
    expect(okBody.job?.status).toBe('pending');
    close();
  });

  it('冷却窗:第二次立即发被台账拦下,落 blocked 审计、不建 job', async () => {
    const close = await subscribe();
    const first = await jpost('/api/media-studio/interaction', REQ);
    expect(first.job?.id).toBeTruthy();
    const second = await jpost('/api/media-studio/interaction', REQ);
    expect(second.job).toBeNull();
    expect(second.blocked?.reason).toBe('cooldown');

    const audit = await jget('/api/media-studio/interactions?platform=xiaohongshu&account=acctA');
    const blocked = (audit.items ?? []).filter((r) => r.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.detail).toBe('cooldown');
    close();
  });

  it('complete 回写 → 落 done 审计', async () => {
    const close = await subscribe();
    const created = await jpost('/api/media-studio/interaction', REQ);
    const id = created.job!.id;
    await post(`/api/media-studio/interaction/${id}/claim`, {});
    const done = await jpost(`/api/media-studio/interaction/${id}/complete`, { ok: true, detail: '已回复' });
    expect(done.job?.status).toBe('done');

    const audit = await jget('/api/media-studio/interactions?platform=xiaohongshu&account=acctA');
    const doneRows = (audit.items ?? []).filter((r) => r.status === 'done');
    expect(doneRows).toHaveLength(1);
    expect(doneRows[0]?.targetRef).toBe('note1');
    close();
  });

  it('peek 只读配额不占名额', async () => {
    const peek = await jget('/api/media-studio/interaction-quota?platform=weibo&account=z');
    expect(peek.allowed).toBe(true);
    expect(peek.usedToday).toBe(0);
  });

  it('参数校验:缺 targetRef/非法 action 报 400', async () => {
    const close = await subscribe();
    expect((await post('/api/media-studio/interaction', { ...REQ, targetRef: '' })).status).toBe(400);
    expect((await post('/api/media-studio/interaction', { ...REQ, action: 'like' })).status).toBe(400);
    close();
  });
});
