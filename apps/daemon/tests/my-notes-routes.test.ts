// 「我的笔记」抓取路由的集成契约:桌面未连拒建、订阅后可建 job、result 落 notes、complete 落终态、
// wait 长轮询拿快照。抓取本身在桌面 webview 里(这里只验 daemon 侧的桥)。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerMediaStudioRoutes } from '../src/media-studio-routes.js';

describe('my-notes routes', () => {
  let tempDir: string;
  let server: ReturnType<express.Express['listen']>;
  let base: string;

  async function start() {
    const app = express();
    app.use(express.json());
    const db = openDatabase(tempDir, { dataDir: tempDir });
    registerMediaStudioRoutes(app, { db, paths: { RUNTIME_DATA_DIR: tempDir, PROJECT_ROOT: tempDir } });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  }

  // my-notes bus 的订阅者由合流端点 /desktop-jobs/events 注入(桌面 web 只开这一条)。
  async function subscribe(): Promise<() => void> {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}/api/media-studio/desktop-jobs/events`, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    await reader.read();
    return () => { try { ctrl.abort(); } catch { /* ignore */ } reader.cancel().catch(() => {}); };
  }

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const jpost = async (p: string, body: unknown): Promise<any> => (await post(p, body)).json();
  const jget = async (p: string): Promise<any> => (await fetch(`${base}${p}`)).json();

  const REQ = { platform: 'xiaohongshu', account: '茂宇' };

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mynotes-'));
    await start();
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('桌面端未连接 → 409(抓笔记要桌面端)', async () => {
    const off = await post('/api/media-studio/my-notes', REQ);
    expect(off.status).toBe(409);
  });

  it('订阅后可建 job（pending）', async () => {
    const close = await subscribe();
    const body = await jpost('/api/media-studio/my-notes', REQ);
    expect(body.job?.status).toBe('pending');
    expect(body.job?.notes).toEqual([]);
    close();
  });

  it('result 落 notes → complete 落 done → wait 拿到', async () => {
    const close = await subscribe();
    const created = await jpost('/api/media-studio/my-notes', REQ);
    const id = created.job!.id;
    await post(`/api/media-studio/my-notes/${id}/claim`, {});
    const notes = [
      { noteId: 'n1', title: '笔记一', url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=abc', likeText: '99' },
      { noteId: 'n2', title: '笔记二', url: 'https://www.xiaohongshu.com/explore/n2?xsec_token=def' },
    ];
    await post(`/api/media-studio/my-notes/${id}/result`, { notes, needsLogin: false, ok: true });
    const done = await jpost(`/api/media-studio/my-notes/${id}/complete`, { ok: true, detail: '读到 2 条' });
    expect(done.job?.status).toBe('done');

    const snap = await jget(`/api/media-studio/my-notes/${id}/wait?since=0&timeoutMs=1000`);
    expect(snap.job.notes).toHaveLength(2);
    expect(snap.job.notes[0].url).toContain('xsec_token=');
    close();
  });

  it('needsLogin 回写(未登录)', async () => {
    const close = await subscribe();
    const created = await jpost('/api/media-studio/my-notes', REQ);
    const id = created.job!.id;
    await post(`/api/media-studio/my-notes/${id}/result`, { notes: [], needsLogin: true, ok: true });
    await post(`/api/media-studio/my-notes/${id}/complete`, { ok: true, detail: '未登录' });
    const j = await jget(`/api/media-studio/my-notes/${id}`);
    expect(j.job.needsLogin).toBe(true);
    expect(j.job.notes).toEqual([]);
    close();
  });

  it('参数校验:缺 platform 报 400', async () => {
    const close = await subscribe();
    expect((await post('/api/media-studio/my-notes', { account: 'x' })).status).toBe(400);
    close();
  });
});
