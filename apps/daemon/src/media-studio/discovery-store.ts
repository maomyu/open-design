import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  MediaDiscoverySnapshot,
  MediaDiscoverySnapshotResponse,
  MediaDiscoverySource,
  MediaStudioPlatform,
  MediaTopicHit,
} from '@open-design/contracts';

type Row = Record<string, unknown>;

const DISCOVERY_SOURCES = new Set<MediaDiscoverySource>(['feishu-monitor', 'manual-grab']);

interface SaveMediaDiscoverySnapshotInput {
  source: MediaDiscoverySource;
  scopeKey?: string;
  query?: string;
  tier?: string;
  items: MediaTopicHit[];
}

export function migrateMediaDiscovery(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_discovery_snapshots (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      source TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      last_attempt_at INTEGER NOT NULL,
      last_attempt_status TEXT NOT NULL DEFAULT 'success',
      UNIQUE(platform, source, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_media_discovery_platform
      ON media_discovery_snapshots(platform, updated_at DESC);
  `);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function label(value: unknown): string {
  return value == null ? '' : String(value);
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function metric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 将爆款引擎的中文字段归一为应用契约。采集 HTTP、飞书监控和 CLI 共用这一处，
 *  避免同一批结果在不同入口落成不同字段。 */
export function mediaTopicHitsFromEngine(items: unknown[]): MediaTopicHit[] {
  const hits: MediaTopicHit[] = [];
  for (const raw of items.slice(0, 200)) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const title = text(item['标题']).trim();
    if (!title) continue;
    const sourceImages = Array.isArray(item['原图'])
      ? item['原图'].filter((url): url is string => typeof url === 'string')
      : [];
    const heat = label(item['热度']).trim();
    const trafficScore = label(item['流量爆款分']).trim();
    const reason = label(item['评分理由']).trim();
    const comments = metric(item['评论']);
    const followers = metric(item['粉丝']);
    hits.push({
      title,
      url: text(item['查看原文'] ?? item['链接']).trim(),
      account: text(item['平台']).trim(),
      publishedAt: text(item['发布时间']).trim(),
      signals: ['trending'],
      readNum: metric(item['播放'] ?? item['阅读']),
      zanNum: metric(item['点赞']),
      hot: [heat ? `${heat}级` : '', trafficScore ? `流量分${trafficScore}` : ''].filter(Boolean).join(' · ') || null,
      desc: [reason, comments ? `评论${comments}` : '', followers ? `粉丝${followers}` : ''].filter(Boolean).join(' · ') || null,
      ...(item['原文案'] ? { sourceContent: String(item['原文案']) } : {}),
      ...(sourceImages.length > 0 ? { sourceImages } : {}),
    });
  }
  return hits;
}

function parseItems(value: unknown): MediaTopicHit[] {
  try {
    const parsed = JSON.parse(text(value) || '[]') as unknown;
    return Array.isArray(parsed) ? parsed as MediaTopicHit[] : [];
  } catch {
    return [];
  }
}

function snapshotFromRow(row: Row): MediaDiscoverySnapshot {
  return {
    id: text(row.id),
    platform: text(row.platform) as MediaStudioPlatform,
    source: text(row.source) as MediaDiscoverySource,
    scopeKey: text(row.scope_key),
    query: text(row.query),
    tier: text(row.tier),
    items: parseItems(row.items_json),
    updatedAt: number(row.updated_at),
    lastAttemptAt: number(row.last_attempt_at),
    lastAttemptStatus: text(row.last_attempt_status) === 'empty' ? 'empty' : 'success',
  };
}

function getSnapshot(
  db: Database.Database,
  platform: string,
  source: MediaDiscoverySource,
  scopeKey: string,
): MediaDiscoverySnapshot | null {
  const row = db.prepare(
    `SELECT * FROM media_discovery_snapshots
     WHERE platform = ? AND source = ? AND scope_key = ?`,
  ).get(platform, source, scopeKey) as Row | undefined;
  return row ? snapshotFromRow(row) : null;
}

export function listMediaDiscoverySnapshots(
  db: Database.Database,
  platform: string,
): MediaDiscoverySnapshot[] {
  const rows = db.prepare(
    `SELECT * FROM media_discovery_snapshots
     WHERE platform = ?
     ORDER BY updated_at DESC, source ASC, scope_key ASC`,
  ).all(platform) as Row[];
  return rows.map(snapshotFromRow);
}

export function saveMediaDiscoverySnapshot(
  db: Database.Database,
  platform: string,
  input: SaveMediaDiscoverySnapshotInput,
  now = Date.now(),
): MediaDiscoverySnapshotResponse {
  if (!DISCOVERY_SOURCES.has(input.source)) throw new Error('invalid discovery source');
  const scopeKey = text(input.scopeKey).trim().slice(0, 200);
  const existing = getSnapshot(db, platform, input.source, scopeKey);
  const items = Array.isArray(input.items) ? input.items.slice(0, 200) : [];

  if (items.length === 0 && existing) {
    db.prepare(
      `UPDATE media_discovery_snapshots
       SET last_attempt_at = ?, last_attempt_status = 'empty'
       WHERE id = ?`,
    ).run(now, existing.id);
    return {
      snapshot: getSnapshot(db, platform, input.source, scopeKey)!,
      retainedPrevious: existing.items.length > 0,
    };
  }

  const id = existing?.id ?? randomUUID();
  const query = text(input.query).trim().slice(0, 300);
  const tier = text(input.tier).trim().slice(0, 100);
  const status = items.length > 0 ? 'success' : 'empty';
  db.prepare(
    `INSERT INTO media_discovery_snapshots
       (id, platform, source, scope_key, query, tier, items_json, updated_at, last_attempt_at, last_attempt_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, source, scope_key) DO UPDATE SET
       query = excluded.query,
       tier = excluded.tier,
       items_json = excluded.items_json,
       updated_at = excluded.updated_at,
       last_attempt_at = excluded.last_attempt_at,
       last_attempt_status = excluded.last_attempt_status`,
  ).run(id, platform, input.source, scopeKey, query, tier, JSON.stringify(items), now, now, status);

  return {
    snapshot: getSnapshot(db, platform, input.source, scopeKey)!,
    retainedPrevious: false,
  };
}

/** 爆款引擎写入飞书的监控结果同步成应用内常驻快照。空轮次仍逐创作台记录，
 *  saveMediaDiscoverySnapshot 会保留各创作台上一批非空内容。 */
export function saveFeishuMonitorDiscoverySnapshots(
  db: Database.Database,
  items: unknown[],
  now = Date.now(),
): Record<string, number> {
  const groups: Record<'short-video' | 'note' | 'wechat-mp', MediaTopicHit[]> = {
    'short-video': [],
    note: [],
    'wechat-mp': [],
  };
  for (const raw of items.slice(0, 200)) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const hit = mediaTopicHitsFromEngine([item])[0];
    if (!hit) continue;
    const sourcePlatform = hit.account;
    const sourceImages = hit.sourceImages ?? [];
    const target = sourcePlatform === '公众号'
      ? 'wechat-mp'
      : sourcePlatform === '小红书' && sourceImages.length > 0 ? 'note' : 'short-video';
    groups[target].push(hit);
  }

  const counts: Record<string, number> = {};
  for (const [platform, groupItems] of Object.entries(groups)) {
    const saved = saveMediaDiscoverySnapshot(db, platform, {
      source: 'feishu-monitor',
      scopeKey: 'scheduled',
      query: '飞书监控',
      items: groupItems,
    }, now);
    counts[platform] = saved.snapshot.items.length;
  }
  return counts;
}
