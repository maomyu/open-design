/**
 * Media Studio store — CRUD over the media_* tables (see db.ts migrate()).
 * Pure data layer: no HTTP concerns, no platform API calls.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CreateMediaArticleRequest,
  CreateMediaSnippetRequest,
  CreateMediaTopicRequest,
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaSnippet,
  MediaTopic,
  UpdateMediaArticleRequest,
  UpdateMediaTopicRequest,
} from '@open-design/contracts';
import { DEFAULT_WECHAT_SKIN } from './wechat-render.js';

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function parseExtra(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function articleFromRow(r: Row): MediaArticle {
  return {
    id: str(r.id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    title: str(r.title),
    digest: str(r.digest),
    topic: strOrNull(r.topic),
    headerMd: str(r.header_md),
    bodyMd: str(r.body_md),
    footerMd: str(r.footer_md),
    skin: str(r.skin) || DEFAULT_WECHAT_SKIN,
    coverSource: str(r.cover_source),
    renderedHtml: strOrNull(r.rendered_html),
    renderedSkin: strOrNull(r.rendered_skin),
    renderedAt: numOrNull(r.rendered_at),
    status: (str(r.status) || 'writing') as MediaArticle['status'],
    extra: parseExtra(r.extra_json),
    createdAt: numOrNull(r.created_at) ?? 0,
    updatedAt: numOrNull(r.updated_at) ?? 0,
  };
}

function summaryFromRow(r: Row): MediaArticleSummary {
  return {
    id: str(r.id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    title: str(r.title),
    topic: strOrNull(r.topic),
    skin: str(r.skin) || DEFAULT_WECHAT_SKIN,
    status: (str(r.status) || 'writing') as MediaArticleSummary['status'],
    updatedAt: numOrNull(r.updated_at) ?? 0,
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

export function listArticles(db: Database.Database, platform: string): MediaArticleSummary[] {
  const rows = db
    .prepare(`SELECT id, platform, account_id, title, topic, skin, status, updated_at, created_at
              FROM media_articles WHERE platform = ? ORDER BY updated_at DESC`)
    .all(platform) as Row[];
  return rows.map(summaryFromRow);
}

export function getArticle(db: Database.Database, id: string): MediaArticle | null {
  const row = db.prepare(`SELECT * FROM media_articles WHERE id = ?`).get(id) as Row | undefined;
  return row ? articleFromRow(row) : null;
}

export function createArticle(
  db: Database.Database,
  platform: string,
  input: CreateMediaArticleRequest,
): MediaArticle {
  const now = Date.now();
  const id = randomUUID();
  let topic = typeof input.topic === 'string' ? input.topic : null;
  let title = str(input.title);
  const extra: Record<string, unknown> = {};
  if (input.fromTopicId) {
    const t = db.prepare(`SELECT * FROM media_topics WHERE id = ?`).get(input.fromTopicId) as Row | undefined;
    if (t) {
      topic = topic ?? str(t.title);
      if (!title) title = str(t.title);
      // 保留原文链接：素材简报（research AI 任务）要用它抓原文。
      if (str(t.url)) extra.topicUrl = str(t.url);
      db.prepare(`UPDATE media_topics SET status = 'used' WHERE id = ?`).run(input.fromTopicId);
    }
  }
  db.prepare(
    `INSERT INTO media_articles (id, platform, account_id, title, digest, topic, header_md, body_md, footer_md, skin, cover_source, extra_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, 'writing', ?, ?)`,
  ).run(
    id,
    platform,
    strOrNull(input.accountId),
    title,
    topic,
    str(input.headerMd),
    str(input.bodyMd),
    str(input.footerMd),
    str(input.skin) || DEFAULT_WECHAT_SKIN,
    Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
    now,
    now,
  );
  return getArticle(db, id)!;
}

const ARTICLE_FIELD_TO_COLUMN: Record<string, string> = {
  title: 'title',
  digest: 'digest',
  topic: 'topic',
  accountId: 'account_id',
  headerMd: 'header_md',
  bodyMd: 'body_md',
  footerMd: 'footer_md',
  skin: 'skin',
  coverSource: 'cover_source',
};

export function updateArticle(
  db: Database.Database,
  id: string,
  patch: UpdateMediaArticleRequest,
): MediaArticle | null {
  const existing = getArticle(db, id);
  if (!existing) return null;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(ARTICLE_FIELD_TO_COLUMN)) {
    const v = (patch as Record<string, unknown>)[field];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(v === null ? null : String(v));
  }
  if (patch.extra && typeof patch.extra === 'object') {
    // Shallow merge; a null value deletes the key.
    const merged: Record<string, unknown> = { ...existing.extra };
    for (const [k, v] of Object.entries(patch.extra)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    sets.push(`extra_json = ?`);
    values.push(JSON.stringify(merged));
  }
  if (sets.length === 0) return existing;
  sets.push(`updated_at = ?`);
  values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE media_articles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getArticle(db, id);
}

export function saveArticleRender(
  db: Database.Database,
  id: string,
  html: string,
  skin: string,
): MediaArticle | null {
  const now = Date.now();
  db.prepare(
    `UPDATE media_articles
     SET rendered_html = ?, rendered_skin = ?, rendered_at = ?,
         status = CASE WHEN status = 'published' THEN status ELSE 'rendered' END,
         updated_at = ?
     WHERE id = ?`,
  ).run(html, skin, now, now, id);
  return getArticle(db, id);
}

export function markArticlePublished(db: Database.Database, id: string): void {
  const now = Date.now();
  db.prepare(`UPDATE media_articles SET status = 'published', updated_at = ? WHERE id = ?`).run(now, id);
}

export function deleteArticle(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM media_articles WHERE id = ?`).run(id).changes > 0;
}

// ---- topics ----

function topicFromRow(r: Row): MediaTopic {
  return {
    id: str(r.id),
    platform: str(r.platform),
    title: str(r.title),
    angle: str(r.angle),
    source: str(r.source),
    url: str(r.url),
    heat: str(r.heat),
    status: (str(r.status) || 'candidate') as MediaTopic['status'],
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

export function listTopics(db: Database.Database, platform: string): MediaTopic[] {
  const rows = db
    .prepare(`SELECT * FROM media_topics WHERE platform = ? ORDER BY created_at DESC`)
    .all(platform) as Row[];
  return rows.map(topicFromRow);
}

export function createTopic(
  db: Database.Database,
  platform: string,
  input: CreateMediaTopicRequest,
): MediaTopic {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_topics (id, platform, title, angle, source, url, heat, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
  ).run(id, platform, input.title, str(input.angle), str(input.source), str(input.url), str(input.heat), Date.now());
  const row = db.prepare(`SELECT * FROM media_topics WHERE id = ?`).get(id) as Row;
  return topicFromRow(row);
}

export function updateTopic(
  db: Database.Database,
  id: string,
  patch: UpdateMediaTopicRequest,
): MediaTopic | null {
  const row = db.prepare(`SELECT * FROM media_topics WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const cols: Record<string, string> = {
    title: 'title', angle: 'angle', source: 'source', url: 'url', heat: 'heat', status: 'status',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(cols)) {
    const v = (patch as Record<string, unknown>)[field];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(String(v));
  }
  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE media_topics SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  return topicFromRow(db.prepare(`SELECT * FROM media_topics WHERE id = ?`).get(id) as Row);
}

export function deleteTopic(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM media_topics WHERE id = ?`).run(id).changes > 0;
}

// ---- snippets（固定开头/结尾片段库） ----

function snippetFromRow(r: Row): MediaSnippet {
  const rawSlot = str(r.slot);
  return {
    id: str(r.id),
    platform: str(r.platform),
    slot: rawSlot === 'footer' ? 'footer' : rawSlot === 'cover' ? 'cover' : 'header',
    name: str(r.name),
    contentMd: str(r.content_md),
    updatedAt: numOrNull(r.updated_at) ?? 0,
  };
}

export function listSnippets(db: Database.Database, platform: string): MediaSnippet[] {
  const rows = db
    .prepare(`SELECT * FROM media_snippets WHERE platform = ? ORDER BY updated_at DESC`)
    .all(platform) as Row[];
  return rows.map(snippetFromRow);
}

export function createSnippet(
  db: Database.Database,
  platform: string,
  input: CreateMediaSnippetRequest,
): MediaSnippet {
  const id = randomUUID();
  const slot = input.slot === 'footer' ? 'footer' : input.slot === 'cover' ? 'cover' : 'header';
  db.prepare(
    `INSERT INTO media_snippets (id, platform, slot, name, content_md, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, platform, slot, input.name, str(input.contentMd), Date.now());
  return snippetFromRow(db.prepare(`SELECT * FROM media_snippets WHERE id = ?`).get(id) as Row);
}

export function deleteSnippet(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM media_snippets WHERE id = ?`).run(id).changes > 0;
}

// ---- publish records ----

function publishFromRow(r: Row): MediaPublishRecord {
  return {
    id: str(r.id),
    articleId: str(r.article_id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    accountName: str(r.account_name),
    status: (str(r.status) === 'ok' ? 'ok' : 'error'),
    draftMediaId: strOrNull(r.draft_media_id),
    failedStep: strOrNull(r.failed_step),
    error: strOrNull(r.error),
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

export function listPublishes(db: Database.Database, articleId: string): MediaPublishRecord[] {
  const rows = db
    .prepare(`SELECT * FROM media_publishes WHERE article_id = ? ORDER BY created_at DESC`)
    .all(articleId) as Row[];
  return rows.map(publishFromRow);
}

export function recordPublish(
  db: Database.Database,
  input: Omit<MediaPublishRecord, 'id' | 'createdAt'>,
): MediaPublishRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_publishes (id, article_id, platform, account_id, account_name, status, draft_media_id, failed_step, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.articleId,
    input.platform,
    input.accountId,
    input.accountName,
    input.status,
    input.draftMediaId,
    input.failedStep,
    input.error,
    Date.now(),
  );
  return publishFromRow(db.prepare(`SELECT * FROM media_publishes WHERE id = ?`).get(id) as Row);
}

// ---- 版本历史（AI 覆盖前的后悔药） ----

function versionFromRow(r: Row): import('@open-design/contracts').MediaArticleVersion {
  return {
    id: str(r.id),
    articleId: str(r.article_id),
    label: str(r.label),
    title: str(r.title),
    digest: str(r.digest),
    headerMd: str(r.header_md),
    bodyMd: str(r.body_md),
    footerMd: str(r.footer_md),
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

export function listVersions(db: Database.Database, articleId: string) {
  const rows = db
    .prepare(`SELECT * FROM media_article_versions WHERE article_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(articleId) as Row[];
  return rows.map(versionFromRow);
}

/** Snapshot the article's editable text fields. Keeps the latest 20 per
 *  article (old ones pruned) so the table can't grow unbounded. */
export function createVersion(db: Database.Database, article: MediaArticle, label: string) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_article_versions (id, article_id, label, title, digest, header_md, body_md, footer_md, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, article.id, label.slice(0, 60), article.title, article.digest, article.headerMd, article.bodyMd, article.footerMd, Date.now());
  db.prepare(
    `DELETE FROM media_article_versions WHERE article_id = ? AND id NOT IN (
       SELECT id FROM media_article_versions WHERE article_id = ? ORDER BY created_at DESC LIMIT 20)`,
  ).run(article.id, article.id);
  return versionFromRow(db.prepare(`SELECT * FROM media_article_versions WHERE id = ?`).get(id) as Row);
}

export function getVersion(db: Database.Database, id: string) {
  const row = db.prepare(`SELECT * FROM media_article_versions WHERE id = ?`).get(id) as Row | undefined;
  return row ? versionFromRow(row) : null;
}

// ---- 知识库 ----

function knowledgeFromRow(r: Row): import('@open-design/contracts').MediaKnowledge {
  return {
    id: str(r.id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    name: str(r.name),
    contentMd: str(r.content_md),
    updatedAt: numOrNull(r.updated_at) ?? 0,
  };
}

export function listKnowledge(db: Database.Database, platform: string) {
  const rows = db
    .prepare(`SELECT * FROM media_knowledge WHERE platform = ? ORDER BY updated_at DESC`)
    .all(platform) as Row[];
  return rows.map(knowledgeFromRow);
}

export function createKnowledge(
  db: Database.Database,
  platform: string,
  input: { name: string; contentMd: string; accountId?: string | null },
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_knowledge (id, platform, account_id, name, content_md, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, platform, input.accountId ?? null, input.name, input.contentMd, Date.now());
  return knowledgeFromRow(db.prepare(`SELECT * FROM media_knowledge WHERE id = ?`).get(id) as Row);
}

export function deleteKnowledge(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM media_knowledge WHERE id = ?`).run(id).changes > 0;
}
