// 状态监控面板路由的集成契约(W7):对每个扫码登录账号,把【登录态 + 今日风控名额 + 今日互动战果】
// 汇成一行,按平台分组。这里种一个小红书账号,经真实 HTTP 造出「已登录 + 1 条成功 + 1 条被拦」,
// 断言 /monitor 聚合正确。
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/db.js';
import { registerMediaStudioRoutes } from '../src/media-studio-routes.js';
import { writeAppConfig } from '../src/app-config.js';

describe('monitor routes', () => {
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

  // 开一条 SSE 当「桌面端订阅者」,让对应 bus 认为桌面在线。返回关闭器。
  async function subscribe(pathname: string): Promise<() => void> {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}${pathname}`, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    await reader.read();
    return () => { try { ctrl.abort(); } catch { /* ignore */ } reader.cancel().catch(() => {}); };
  }

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const jpost = async (p: string, body: unknown): Promise<any> => (await post(p, body)).json();
  const jget = async (p: string): Promise<any> => (await fetch(`${base}${p}`)).json();

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
    await start();
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('无账号 → items 空(200)', async () => {
    const data = await jget('/api/media-studio/monitor');
    expect(data.items).toEqual([]);
    expect(typeof data.dayStartMs).toBe('number');
  });

  it('聚合:已登录 + 今日 1 成功 1 被拦 + 名额已用 1', async () => {
    // 种一个小红书账号(账号名=互动/登录态全链路的键)。
    await writeAppConfig(tempDir, { platformAccounts: { xiaohongshu: [{ id: 'm1', name: 'acctM' }] } });

    // 登录态:login-check /result loggedIn=true → 落 logged-in。
    const lcOff = await subscribe('/api/media-studio/login-check/events');
    const lc = await jpost('/api/media-studio/login-check', { platform: 'xiaohongshu', account: 'acctM' });
    await post(`/api/media-studio/login-check/${lc.job.id}/result`, { loggedIn: true, detail: '仍登录' });
    lcOff();

    // 互动审计:一条成功(done)+ 一条被冷却拦(blocked)。
    const ixOff = await subscribe('/api/media-studio/interaction/events');
    const REQ = { platform: 'xiaohongshu', account: 'acctM', action: 'reply', targetRef: 'note1', text: '谢谢～' };
    const first = await jpost('/api/media-studio/interaction', REQ);
    await post(`/api/media-studio/interaction/${first.job.id}/claim`, {});
    await post(`/api/media-studio/interaction/${first.job.id}/complete`, { ok: true, detail: '已回复' });
    const second = await jpost('/api/media-studio/interaction', REQ); // 立即再发 → 冷却拦
    expect(second.job).toBeNull();
    expect(second.blocked?.reason).toBe('cooldown');
    ixOff();

    const data = await jget('/api/media-studio/monitor?platform=xiaohongshu');
    expect(data.items).toHaveLength(1);
    const row = data.items[0];
    expect(row.platform).toBe('xiaohongshu');
    expect(row.account).toBe('acctM');
    expect(row.login?.state).toBe('logged-in');
    expect(row.quota.usedToday).toBe(1);
    expect(row.quota.dailyCap).toBeGreaterThan(0);
    expect(row.today.sent).toBe(1);
    expect(row.today.blocked).toBe(1);
    expect(row.today.failed).toBe(0);
  });

  it('公众号(api-credential)不进监控面板(只看扫码登录类)', async () => {
    await writeAppConfig(tempDir, { platformAccounts: { 'wechat-mp': [{ id: 'w1', name: '公众号A', credentials: { WECHAT_APPID: 'a' } }] } });
    const data = await jget('/api/media-studio/monitor');
    expect(data.items.find((i: any) => i.platform === 'wechat-mp')).toBeUndefined();
  });
});
