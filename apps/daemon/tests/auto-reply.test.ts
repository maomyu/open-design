// 自动回复编排的集成契约(W8:读评论→匹配规则→计划/派发)。用一个假桌面端(SSE 订阅者)应答
// read-comments job(回一批假评论),验证 dryRun 预览能读→匹配→出计划;真发能派发回复 job。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerMediaStudioRoutes } from '../src/media-studio-routes.js';
import { createInteractionRule } from '../src/media-studio/store.js';

describe('auto-reply orchestration', () => {
  let tempDir: string;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let db: ReturnType<typeof openDatabase>;

  async function start() {
    const app = express();
    app.use(express.json());
    db = openDatabase(tempDir, { dataDir: tempDir });
    registerMediaStudioRoutes(app, { db, paths: { RUNTIME_DATA_DIR: tempDir, PROJECT_ROOT: tempDir } });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((res, rej) => { server.once('listening', () => res()); server.once('error', rej); });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  }

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // 假桌面端里回写用:关闭期服务器已关,fetch 会 ECONNRESET——best-effort,吞掉,不算测试错误。
  const postBE = (p: string, body: unknown) => post(p, body).catch(() => undefined);

  // 假桌面端:订阅 read-comments SSE + interaction SSE。收到读评论 job → 认领 → 回一批假评论 → 完成。
  // 收到互动(回复)job → 认领 → 完成(ok)。返回关闭器。
  async function fakeDesktop(comments: Array<{ id: string; author: string; text: string; subReplies?: unknown[] }>): Promise<() => Promise<void>> {
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    let closing = false;
    const listen = async (url: string, onJob: (job: { id: string }) => void) => {
      const resp = await fetch(`${base}${url}`);
      const reader = resp.body!.getReader(); readers.push(reader);
      const dec = new TextDecoder();
      await reader.read(); // 先读首帧(': connected')确保订阅已注册,再起循环(避免两处并发 read 同一流)
      let buf = '';
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const frames = buf.split('\n\n'); buf = frames.pop() ?? '';
            for (const f of frames) {
              const m = f.match(/^event: job\ndata: (.+)$/m);
              if (m) { try { onJob(JSON.parse(m[1]!)); } catch { /* ignore */ } }
            }
          }
        } catch { if (!closing) throw new Error('sse read failed'); /* 关闭期 cancel 引发的读中断,静默 */ }
      })();
    };
    await listen('/api/media-studio/read-comments/events', (job) => {
      void (async () => {
        await postBE(`/api/media-studio/read-comments/${job.id}/claim`, {});
        await postBE(`/api/media-studio/read-comments/${job.id}/result`, { comments: comments.map((c) => ({ subReplies: [], ...c })), ok: true });
        await postBE(`/api/media-studio/read-comments/${job.id}/complete`, { ok: true });
      })();
    });
    await listen('/api/media-studio/interaction/events', (job) => {
      void postBE(`/api/media-studio/interaction/${job.id}/complete`, { ok: true, detail: '已回复' });
    });
    return async () => { closing = true; await Promise.all(readers.map((r) => r.cancel().catch(() => {}))); };
  }

  beforeEach(async () => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'autoreply-')); await start(); });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); closeDatabase(); rmSync(tempDir, { recursive: true, force: true }); });

  it('dryRun 预览:读评论→匹配规则→出回复计划,不外发', async () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: '问价', keywords: ['多少钱', '价格'], replyTemplate: '@{author} 私信报价给你', priority: 10 });
    const close = await fakeDesktop([
      { id: 'c1', author: '小明', text: '这条项链多少钱呀' },
      { id: 'c2', author: '小红', text: '拍得真好看' },
    ]);
    const r = await (await post('/api/media-studio/auto-reply', { platform: 'xiaohongshu', account: '茂宇', noteRef: 'https://www.xiaohongshu.com/explore/n1', dryRun: true })).json() as { read: number; matched: Array<{ author: string; reply: string }>; dispatched: unknown[] };
    expect(r.read).toBe(2);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]?.author).toBe('小明');
    expect(r.matched[0]?.reply).toBe('@小明 私信报价给你');
    expect(r.dispatched).toHaveLength(0); // 预览不派发
    await close();
  });

  it('真发:命中的评论派发回复 job(第一条过风控,后续冷却拦)', async () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: '求教程', keywords: ['教程'], replyTemplate: '发你啦', priority: 5 });
    const close = await fakeDesktop([
      { id: 'c1', author: 'A', text: '求教程' },
      { id: 'c2', author: 'B', text: '教程在哪' },
    ]);
    const r = await (await post('/api/media-studio/auto-reply', { platform: 'xiaohongshu', account: '茂宇', noteRef: 'https://www.xiaohongshu.com/explore/n1', dryRun: false, maxReplies: 5 })).json() as { read: number; matched: unknown[]; dispatched: Array<{ jobId: string | null; blocked?: string }> };
    expect(r.matched).toHaveLength(2);
    const sent = r.dispatched.filter((d) => d.jobId);
    const blocked = r.dispatched.filter((d) => d.blocked);
    expect(sent.length).toBe(1);              // 第一条真派发
    expect(blocked.length).toBe(1);           // 第二条同刻被冷却拦(W1 台账)
    expect(blocked[0]?.blocked).toBe('cooldown');
    await close();
  });

  it('缺省 dryRun 当预览(安全默认,不误发)', async () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: 'r', keywords: ['价格'], replyTemplate: 'x' });
    const close = await fakeDesktop([{ id: 'c1', author: 'A', text: '价格多少' }]);
    const r = await (await post('/api/media-studio/auto-reply', { platform: 'xiaohongshu', noteRef: 'n1' })).json() as { dispatched: unknown[] };
    expect(r.dispatched).toHaveLength(0); // 没显式 dryRun:false → 不外发
    await close();
  });
});
