import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { MediaTopicHit } from '@open-design/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listMediaDiscoverySnapshots,
  mediaTopicHitsFromEngine,
  migrateMediaDiscovery,
  saveMediaDiscoverySnapshot,
  saveFeishuMonitorDiscoverySnapshots,
} from '../src/media-studio/discovery-store.js';

function hit(title: string, url: string) {
  return {
    title,
    url,
    account: '测试账号',
    publishedAt: '',
    signals: ['trending'] as MediaTopicHit['signals'],
    readNum: 100_000,
    zanNum: 8_000,
    hot: 'A级',
    desc: '测试爆款',
  };
}

describe('media discovery snapshot persistence', () => {
  const databases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    databases.push(db);
    migrateMediaDiscovery(db);
    return db;
  }

  it('migrates idempotently', () => {
    const db = freshDb();
    expect(() => migrateMediaDiscovery(db)).not.toThrow();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_discovery_snapshots'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('media_discovery_snapshots');
  });

  it('survives closing and reopening the SQLite database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'od-media-discovery-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'app.sqlite');
    const firstDb = new Database(databasePath);
    migrateMediaDiscovery(firstDb);
    saveMediaDiscoverySnapshot(firstDb, 'short-video', {
      source: 'manual-grab',
      scopeKey: 'douyin',
      query: '持久化',
      items: [hit('重启后还在', 'https://example.com/restart')],
    }, 100);
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    databases.push(reopenedDb);
    migrateMediaDiscovery(reopenedDb);
    expect(listMediaDiscoverySnapshots(reopenedDb, 'short-video')).toMatchObject([{
      source: 'manual-grab',
      items: [{ title: '重启后还在' }],
    }]);
  });

  it('keeps the last successful non-empty batch when a later collection is empty', () => {
    const db = freshDb();
    const first = saveMediaDiscoverySnapshot(db, 'short-video', {
      source: 'manual-grab',
      scopeKey: 'douyin',
      query: '变帅',
      tier: '爆款',
      items: [hit('第一批爆款', 'https://example.com/first')],
    }, 100);

    const emptyAttempt = saveMediaDiscoverySnapshot(db, 'short-video', {
      source: 'manual-grab',
      scopeKey: 'douyin',
      query: '冷门词',
      items: [],
    }, 200);

    expect(first.retainedPrevious).toBe(false);
    expect(emptyAttempt.retainedPrevious).toBe(true);
    expect(emptyAttempt.snapshot).toMatchObject({
      query: '变帅',
      tier: '爆款',
      updatedAt: 100,
      lastAttemptAt: 200,
      lastAttemptStatus: 'empty',
    });
    expect(emptyAttempt.snapshot.items.map((item) => item.title)).toEqual(['第一批爆款']);
  });

  it('replaces only the matching source and scope when a new non-empty batch arrives', () => {
    const db = freshDb();
    saveMediaDiscoverySnapshot(db, 'short-video', {
      source: 'manual-grab',
      scopeKey: 'douyin',
      query: '手动旧批次',
      items: [hit('手动旧爆款', 'https://example.com/manual-old')],
    }, 100);
    saveMediaDiscoverySnapshot(db, 'short-video', {
      source: 'feishu-monitor',
      scopeKey: 'scheduled',
      query: '自动监控',
      items: [hit('飞书监控爆款', 'https://example.com/feishu')],
    }, 110);
    saveMediaDiscoverySnapshot(db, 'short-video', {
      source: 'manual-grab',
      scopeKey: 'douyin',
      query: '手动新批次',
      items: [hit('手动新爆款', 'https://example.com/manual-new')],
    }, 200);

    const snapshots = listMediaDiscoverySnapshots(db, 'short-video');
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((snapshot) => snapshot.source === 'manual-grab')).toMatchObject({
      query: '手动新批次',
      items: [{ title: '手动新爆款' }],
    });
    expect(snapshots.find((snapshot) => snapshot.source === 'feishu-monitor')).toMatchObject({
      query: '自动监控',
      items: [{ title: '飞书监控爆款' }],
    });
  });

  it('keeps Feishu monitor results in their own lane across an empty scheduled run', () => {
    const db = freshDb();
    saveFeishuMonitorDiscoverySnapshots(db, [{
      标题: '监控抓到的视频',
      平台: '抖音',
      查看原文: 'https://example.com/monitor-video',
      播放: 900_000,
      点赞: 50_000,
      热度: 'A',
      评分理由: '低粉高赞',
    }], 100);
    saveFeishuMonitorDiscoverySnapshots(db, [], 200);

    const snapshot = listMediaDiscoverySnapshots(db, 'short-video')[0];
    expect(snapshot).toMatchObject({
      source: 'feishu-monitor',
      scopeKey: 'scheduled',
      updatedAt: 100,
      lastAttemptAt: 200,
      lastAttemptStatus: 'empty',
      items: [{ title: '监控抓到的视频' }],
    });
  });

  it('normalizes engine output once so HTTP, UI, and CLI persist the same hit shape', () => {
    expect(mediaTopicHitsFromEngine([{
      标题: '统一结果',
      平台: '抖音',
      查看原文: 'https://example.com/shared',
      播放: '120000',
      点赞: 9000,
      评论: 321,
      粉丝: 4567,
      热度: 'A',
      流量爆款分: 88,
      评分理由: '互动突出',
    }])).toEqual([expect.objectContaining({
      title: '统一结果',
      url: 'https://example.com/shared',
      account: '抖音',
      readNum: 120000,
      zanNum: 9000,
      hot: 'A级 · 流量分88',
      desc: '互动突出 · 评论321 · 粉丝4567',
    })]);
  });
});
