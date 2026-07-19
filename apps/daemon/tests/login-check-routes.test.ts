// 登录态保活路由的集成契约(W6):桌面未连拒建、订阅后可建 job、result 回写落 media_login_status、
// 从「已登录→已失效」翻转产一条 login-expired 告警、dismiss 后不再列出。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerMediaStudioRoutes } from '../src/media-studio-routes.js';

describe('login-check routes', () => {
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

  // 开一条 SSE 连接当「桌面端订阅者」,让 bus 认为桌面在线。返回关闭器。
  async function subscribe(): Promise<() => void> {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}/api/media-studio/login-check/events`, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    await reader.read(); // 读到首帧确保订阅已注册
    return () => { try { ctrl.abort(); } catch { /* ignore */ } reader.cancel().catch(() => {}); };
  }

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  type Rec = { platform: string; account: string; state: string; detail: string | null; checkedAt: number };
  type Alert = { id: string; kind: string; account: string | null; message: string };
  type Body = { job?: { id: string; status: string } | null; items?: Rec[] & Alert[]; ok?: boolean };
  const jpost = async (p: string, body: unknown): Promise<Body> => (await post(p, body)).json() as Promise<Body>;
  const jget = async (p: string): Promise<Body> => (await fetch(`${base}${p}`)).json() as Promise<Body>;

  const REQ = { platform: 'xiaohongshu', account: 'acctA' };

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'lc-routes-'));
    await start();
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('桌面端未连接 → 409(登录探测要桌面端)', async () => {
    const off = await post('/api/media-studio/login-check', REQ);
    expect(off.status).toBe(409);
  });

  it('订阅后可建 job（pending）', async () => {
    const close = await subscribe();
    const body = await jpost('/api/media-studio/login-check', REQ);
    expect(body.job?.status).toBe('pending');
    close();
  });

  it('result 回写 loggedIn=true → 落 media_login_status（logged-in）', async () => {
    const close = await subscribe();
    const created = await jpost('/api/media-studio/login-check', REQ);
    const id = created.job!.id;
    await post(`/api/media-studio/login-check/${id}/result`, { loggedIn: true, detail: '仍登录' });
    const status = await jget('/api/media-studio/login-status?platform=xiaohongshu');
    const rec = (status.items ?? []).find((r) => (r as Rec).account === 'acctA') as Rec | undefined;
    expect(rec?.state).toBe('logged-in');
    // 首次落态(无前值)不算翻转 → 不产告警。
    const alerts = await jget('/api/media-studio/alerts');
    expect(alerts.items ?? []).toHaveLength(0);
    close();
  });

  it('已登录→已失效翻转 → 产一条 login-expired 告警;dismiss 后不再列出', async () => {
    const close = await subscribe();
    // 先落一次已登录。
    const j1 = (await jpost('/api/media-studio/login-check', REQ)).job!.id;
    await post(`/api/media-studio/login-check/${j1}/result`, { loggedIn: true });
    // 再落一次已失效 → 翻转。
    const j2 = (await jpost('/api/media-studio/login-check', REQ)).job!.id;
    await post(`/api/media-studio/login-check/${j2}/result`, { loggedIn: false, detail: '掉线' });

    const alerts = await jget('/api/media-studio/alerts');
    const items = (alerts.items ?? []) as unknown as Alert[];
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('login-expired');
    expect(items[0]?.account).toBe('acctA');

    // 状态也应变为 logged-out。
    const status = await jget('/api/media-studio/login-status');
    const rec = (status.items ?? []).find((r) => (r as Rec).account === 'acctA') as Rec | undefined;
    expect(rec?.state).toBe('logged-out');

    // dismiss → 默认列表不再含它。
    const okBody = await jpost(`/api/media-studio/alerts/${items[0]!.id}/dismiss`, {});
    expect(okBody.ok).toBe(true);
    const after = await jget('/api/media-studio/alerts');
    expect(after.items ?? []).toHaveLength(0);
    close();
  });

  it('持续失效(logged-out→logged-out)不重复产告警', async () => {
    const close = await subscribe();
    const j1 = (await jpost('/api/media-studio/login-check', REQ)).job!.id;
    await post(`/api/media-studio/login-check/${j1}/result`, { loggedIn: false });
    const j2 = (await jpost('/api/media-studio/login-check', REQ)).job!.id;
    await post(`/api/media-studio/login-check/${j2}/result`, { loggedIn: false });
    // 从未登录过 → 两次都不是「从已登录翻转」→ 无告警。
    const alerts = await jget('/api/media-studio/alerts');
    expect(alerts.items ?? []).toHaveLength(0);
    close();
  });

  it('参数校验:缺 platform/account 报 400', async () => {
    const close = await subscribe();
    expect((await post('/api/media-studio/login-check', { platform: '', account: 'x' })).status).toBe(400);
    expect((await post('/api/media-studio/login-check', { platform: 'weibo', account: '' })).status).toBe(400);
    close();
  });
});
