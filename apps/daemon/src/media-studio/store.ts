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
  InteractionAction,
  InteractionRecord,
  InteractionRule,
  InteractionStatus,
  RuleMatchMode,
  CreateInteractionRuleRequest,
  UpdateInteractionRuleRequest,
  LoginState,
  LoginStatusRecord,
  MediaAlert,
  AlertKind,
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaSnippet,
  MediaTopic,
  UpdateMediaArticleRequest,
  UpdateMediaTopicRequest,
} from '@open-design/contracts';
import { DEFAULT_WECHAT_SKIN } from './wechat-render.js';
import {
  DEFAULT_INTERACTION_POLICY,
  decideQuota,
  type InteractionPolicy,
  type QuotaDecision,
  type QuotaState,
} from './interaction-quota.js';

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
  // 子平台:短视频台按平台分视图用(= extra.targetPlatform)。只在 SELECT
  // 带了 extra_json 时可解出;不带则为空(其它创作台不需要)。
  const subPlatform = r.extra_json !== undefined
    ? str((parseExtra(r.extra_json) as { targetPlatform?: unknown }).targetPlatform)
    : '';
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
    ...(subPlatform ? { subPlatform } : {}),
  };
}

export function listArticles(db: Database.Database, platform: string): MediaArticleSummary[] {
  const rows = db
    .prepare(`SELECT id, platform, account_id, title, topic, skin, status, extra_json, updated_at, created_at
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
  const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
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
    ...(str(r.source_content) ? { sourceContent: str(r.source_content) } : {}),
    ...((() => { try { const a = JSON.parse(str(r.source_images) || '[]'); return Array.isArray(a) && a.length ? { sourceImages: a.filter((u: unknown): u is string => typeof u === 'string') } : {}; } catch { return {}; } })()),
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
  const srcImages = Array.isArray(input.sourceImages) && input.sourceImages.length
    ? JSON.stringify(input.sourceImages.filter((u): u is string => typeof u === 'string'))
    : '';
  db.prepare(
    `INSERT INTO media_topics (id, platform, title, angle, source, url, heat, status, source_content, source_images, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
  ).run(id, platform, input.title, str(input.angle), str(input.source), str(input.url), str(input.heat), str(input.sourceContent), srcImages, Date.now());
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
    category: str(r.category) || 'other',
    updatedAt: numOrNull(r.updated_at) ?? 0,
  };
}

// 知识库是公司级全局资产(2026-07-08 用户拍板):一处维护,公众号/短视频/笔记
// 所有创作台的 AI 任务都注入同一份。读写在这里强制归一到 'global'——不管调用方
// (HTTP :platform 段、CLI --platform)传什么平台,都落到/查到同一份全局库,
// 老入口无需改造也不会写出"孤儿平台"条目。db.ts 迁移已把历史数据归并过来。
const KNOWLEDGE_PLATFORM = 'global';

export function listKnowledge(db: Database.Database, _platform?: string) {
  const rows = db
    .prepare(`SELECT * FROM media_knowledge WHERE platform = ? ORDER BY updated_at DESC`)
    .all(KNOWLEDGE_PLATFORM) as Row[];
  return rows.map(knowledgeFromRow);
}

export function createKnowledge(
  db: Database.Database,
  _platform: string,
  input: { name: string; contentMd: string; accountId?: string | null; category?: string },
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_knowledge (id, platform, account_id, name, content_md, category, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, KNOWLEDGE_PLATFORM, input.accountId ?? null, input.name, input.contentMd, input.category || 'other', Date.now());
  return knowledgeFromRow(db.prepare(`SELECT * FROM media_knowledge WHERE id = ?`).get(id) as Row);
}

export function deleteKnowledge(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM media_knowledge WHERE id = ?`).run(id).changes > 0;
}

export function getKnowledge(db: Database.Database, id: string) {
  const row = db.prepare(`SELECT * FROM media_knowledge WHERE id = ?`).get(id) as Row | undefined;
  return row ? knowledgeFromRow(row) : null;
}

// ---- 互动风控台账（自动评论/楼中楼/私信的审计 + 按账号限流）----

function interactionFromRow(r: Row): InteractionRecord {
  const action = str(r.action);
  const status = str(r.status);
  return {
    id: str(r.id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    action: (action === 'sub-reply' || action === 'dm' ? action : 'reply') as InteractionAction,
    targetRef: str(r.target_ref),
    text: str(r.text),
    status: (status === 'error' || status === 'blocked' ? status : 'done') as InteractionStatus,
    detail: strOrNull(r.detail),
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

/** 落一条互动审计（外发成功、报错、被风控拦截都留痕）。 */
export function recordInteraction(
  db: Database.Database,
  input: {
    platform: string;
    accountId?: string | null;
    action: InteractionAction;
    targetRef: string;
    text: string;
    status: InteractionStatus;
    detail?: string | null;
    at?: number;
  },
): InteractionRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_interactions (id, platform, account_id, action, target_ref, text, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.platform,
    input.accountId ?? null,
    input.action,
    input.targetRef,
    input.text,
    input.status,
    input.detail ?? null,
    input.at ?? Date.now(),
  );
  return interactionFromRow(db.prepare(`SELECT * FROM media_interactions WHERE id = ?`).get(id) as Row);
}

export function listInteractions(
  db: Database.Database,
  filter: { platform?: string; accountId?: string | null; limit?: number } = {},
): InteractionRecord[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.platform) { where.push('platform = ?'); args.push(filter.platform); }
  if (filter.accountId !== undefined) { where.push('account_id IS ?'); args.push(filter.accountId ?? null); }
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT * FROM media_interactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args, limit) as Row[];
  return rows.map(interactionFromRow);
}

/** 账号维度归一：无账号时统一用空串键,和建表默认一致(避免 NULL 主键把不同账号并成一行)。 */
function quotaAccountKey(accountId?: string | null): string {
  return accountId ?? '';
}

function readQuotaState(db: Database.Database, platform: string, accountId?: string | null): QuotaState | null {
  const row = db
    .prepare(`SELECT day, count, last_action_at FROM media_interaction_quota WHERE platform = ? AND account_id = ?`)
    .get(platform, quotaAccountKey(accountId)) as Row | undefined;
  if (!row) return null;
  return {
    day: numOrNull(row.day) ?? 0,
    count: numOrNull(row.count) ?? 0,
    lastActionAt: numOrNull(row.last_action_at) ?? 0,
  };
}

/** 只读地看某账号当前配额判定（不占用名额；供前端/CLI 预检、或执行器排程参考）。 */
export function peekInteractionQuota(
  db: Database.Database,
  platform: string,
  accountId: string | null,
  policy: InteractionPolicy = DEFAULT_INTERACTION_POLICY,
  now: number = Date.now(),
): QuotaDecision {
  return decideQuota(readQuotaState(db, platform, accountId), policy, now);
}

/**
 * 原子认领一个互动名额：在一个事务里「读配额→纯决策→放行则记账」，杜绝并发穿透
 * （两个同刻请求，第二个会看到第一个刚写的 last_action_at 而被冷却拦下）。
 * 放行返回 {allowed:true}，调用方随后执行真实外发并另记 recordInteraction 审计；
 * 拦截返回 {allowed:false, reason}，不占名额。
 */
export function claimInteractionSlot(
  db: Database.Database,
  platform: string,
  accountId: string | null,
  policy: InteractionPolicy = DEFAULT_INTERACTION_POLICY,
  now: number = Date.now(),
): QuotaDecision {
  const tz = policy.tzOffsetMinutes ?? 480;
  const today = Math.floor((now + tz * 60_000) / 86_400_000);
  const key = quotaAccountKey(accountId);
  const txn = db.transaction((): QuotaDecision => {
    const state = readQuotaState(db, platform, accountId);
    const decision = decideQuota(state, policy, now);
    if (!decision.allowed) return decision;
    // 放行：占用名额。跨天则计数从 1 起，否则 +1；刷新 last_action_at 为地板起点。
    const nextCount = state && state.day === today ? state.count + 1 : 1;
    db.prepare(
      `INSERT INTO media_interaction_quota (platform, account_id, day, count, last_action_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform, account_id) DO UPDATE SET day = excluded.day, count = excluded.count, last_action_at = excluded.last_action_at`,
    ).run(platform, key, today, nextCount, now);
    return { ...decision, usedToday: nextCount };
  });
  return txn();
}

// ---- 互动匹配规则（命中关键词→回复模板;自动评论回复的大脑）----

function ruleFromRow(r: Row): InteractionRule {
  let keywords: string[] = [];
  try {
    const p = JSON.parse(str(r.keywords_json, '[]'));
    if (Array.isArray(p)) keywords = p.filter((k): k is string => typeof k === 'string');
  } catch { /* 坏 JSON 当空 */ }
  const mode = str(r.match_mode, 'contains');
  const action = str(r.action, 'reply');
  return {
    id: str(r.id),
    platform: str(r.platform),
    accountId: strOrNull(r.account_id),
    name: str(r.name),
    keywords,
    matchMode: (mode === 'exact' || mode === 'regex' ? mode : 'contains') as RuleMatchMode,
    replyTemplate: str(r.reply_template),
    // 'ai' 时 reply_template 存的是意图而非文案;未知值一律当 'template'(老行为),
    // 绝不能把意图误当文案发出去。
    replyMode: str(r.reply_mode, 'template') === 'ai' ? 'ai' : 'template',
    action: (action === 'sub-reply' || action === 'dm' ? action : 'reply') as InteractionAction,
    priority: numOrNull(r.priority) ?? 0,
    enabled: (numOrNull(r.enabled) ?? 1) !== 0,
    createdAt: numOrNull(r.created_at) ?? 0,
  };
}

/** 列规则:按平台(可选账号)取,优先级降序。account 传 null/省略=只取平台通用(account_id IS NULL)+
 *  该账号专属;传具体账号名时把"通用规则 + 该账号规则"一起返回(匹配时账号专属优先靠 priority)。 */
export function listInteractionRules(
  db: Database.Database,
  platform: string,
  accountId?: string | null,
): InteractionRule[] {
  let rows: Row[];
  if (accountId === undefined) {
    rows = db.prepare(`SELECT * FROM interaction_rules WHERE platform = ? ORDER BY priority DESC, created_at`).all(platform) as Row[];
  } else if (accountId === null) {
    rows = db.prepare(`SELECT * FROM interaction_rules WHERE platform = ? AND account_id IS NULL ORDER BY priority DESC, created_at`).all(platform) as Row[];
  } else {
    rows = db.prepare(`SELECT * FROM interaction_rules WHERE platform = ? AND (account_id IS NULL OR account_id = ?) ORDER BY priority DESC, created_at`).all(platform, accountId) as Row[];
  }
  return rows.map(ruleFromRow);
}

export function getInteractionRule(db: Database.Database, id: string): InteractionRule | null {
  const row = db.prepare(`SELECT * FROM interaction_rules WHERE id = ?`).get(id) as Row | undefined;
  return row ? ruleFromRow(row) : null;
}

export function createInteractionRule(db: Database.Database, input: CreateInteractionRuleRequest): InteractionRule {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO interaction_rules (id, platform, account_id, name, keywords_json, match_mode, reply_template, reply_mode, action, priority, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.platform,
    input.accountId ?? null,
    input.name,
    JSON.stringify(Array.isArray(input.keywords) ? input.keywords : []),
    input.matchMode ?? 'contains',
    input.replyTemplate,
    input.replyMode === 'ai' ? 'ai' : 'template',
    input.action ?? 'reply',
    Number.isFinite(input.priority) ? Number(input.priority) : 0,
    input.enabled === false ? 0 : 1,
    Date.now(),
  );
  return ruleFromRow(db.prepare(`SELECT * FROM interaction_rules WHERE id = ?`).get(id) as Row);
}

export function updateInteractionRule(db: Database.Database, id: string, patch: UpdateInteractionRuleRequest): InteractionRule | null {
  const existing = getInteractionRule(db, id);
  if (!existing) return null;
  const next = {
    accountId: patch.accountId !== undefined ? patch.accountId : existing.accountId,
    name: patch.name ?? existing.name,
    keywords: patch.keywords ?? existing.keywords,
    matchMode: patch.matchMode ?? existing.matchMode,
    replyTemplate: patch.replyTemplate ?? existing.replyTemplate,
    replyMode: patch.replyMode ?? existing.replyMode ?? 'template',
    action: patch.action ?? existing.action,
    priority: patch.priority !== undefined ? patch.priority : existing.priority,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
  };
  db.prepare(
    `UPDATE interaction_rules SET account_id = ?, name = ?, keywords_json = ?, match_mode = ?, reply_template = ?, reply_mode = ?, action = ?, priority = ?, enabled = ? WHERE id = ?`,
  ).run(
    next.accountId ?? null,
    next.name,
    JSON.stringify(next.keywords),
    next.matchMode,
    next.replyTemplate,
    next.replyMode,
    next.action,
    next.priority,
    next.enabled ? 1 : 0,
    id,
  );
  return getInteractionRule(db, id);
}

export function deleteInteractionRule(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM interaction_rules WHERE id = ?`).run(id).changes > 0;
}

// ---- 登录态保活 + 告警（W6）----

function loginStatusFromRow(r: Row): LoginStatusRecord {
  const s = str(r.state, 'unknown');
  return {
    platform: str(r.platform),
    account: str(r.account),
    state: (s === 'logged-in' || s === 'logged-out' ? s : 'unknown') as LoginState,
    detail: strOrNull(r.detail),
    checkedAt: numOrNull(r.checked_at) ?? 0,
  };
}

export function listLoginStatus(db: Database.Database, platform?: string): LoginStatusRecord[] {
  const rows = platform
    ? db.prepare(`SELECT * FROM media_login_status WHERE platform = ? ORDER BY platform, account`).all(platform) as Row[]
    : db.prepare(`SELECT * FROM media_login_status ORDER BY platform, account`).all() as Row[];
  return rows.map(loginStatusFromRow);
}

export function getLoginStatus(db: Database.Database, platform: string, account: string): LoginStatusRecord | null {
  const row = db.prepare(`SELECT * FROM media_login_status WHERE platform = ? AND account = ?`).get(platform, account) as Row | undefined;
  return row ? loginStatusFromRow(row) : null;
}

/** 落一次登录校验结果。返回是否【从已登录翻转到已失效】(调用方据此产告警,只在真正掉线时提醒)。 */
export function setLoginStatus(
  db: Database.Database,
  platform: string,
  account: string,
  state: LoginState,
  detail: string | null = null,
  at: number = Date.now(),
): { flippedToLoggedOut: boolean } {
  const prev = getLoginStatus(db, platform, account);
  db.prepare(
    `INSERT INTO media_login_status (platform, account, state, detail, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform, account) DO UPDATE SET state = excluded.state, detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(platform, account, state, detail, at);
  return { flippedToLoggedOut: prev?.state === 'logged-in' && state === 'logged-out' };
}

function alertFromRow(r: Row): MediaAlert {
  const kind = str(r.kind);
  return {
    id: str(r.id),
    kind: (kind === 'risk-control' ? 'risk-control' : 'login-expired') as AlertKind,
    platform: str(r.platform),
    account: strOrNull(r.account),
    message: str(r.message),
    createdAt: numOrNull(r.created_at) ?? 0,
    dismissed: (numOrNull(r.dismissed) ?? 0) !== 0,
  };
}

export function createAlert(
  db: Database.Database,
  input: { kind: AlertKind; platform: string; account?: string | null; message: string; at?: number },
): MediaAlert {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_alerts (id, kind, platform, account, message, created_at, dismissed) VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, input.kind, input.platform, input.account ?? null, input.message, input.at ?? Date.now());
  return alertFromRow(db.prepare(`SELECT * FROM media_alerts WHERE id = ?`).get(id) as Row);
}

export function listAlerts(db: Database.Database, opts: { includeDismissed?: boolean; limit?: number } = {}): MediaAlert[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const rows = opts.includeDismissed
    ? db.prepare(`SELECT * FROM media_alerts ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]
    : db.prepare(`SELECT * FROM media_alerts WHERE dismissed = 0 ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[];
  return rows.map(alertFromRow);
}

export function dismissAlert(db: Database.Database, id: string): boolean {
  return db.prepare(`UPDATE media_alerts SET dismissed = 1 WHERE id = ?`).run(id).changes > 0;
}

/** 账号重新确认「已登录」时,把它名下未消隐的登录失效告警一并消掉——否则补登(或本就没掉线)后
 *  红色「去补登」条还挂着,出现「检测明明是已登录却还提示补登」(2026-07-21 用户反馈)。 */
export function dismissLoginAlertsFor(db: Database.Database, platform: string, account: string | null): number {
  return db.prepare(
    `UPDATE media_alerts SET dismissed = 1 WHERE dismissed = 0 AND kind = 'login-expired' AND platform = ? AND account IS ?`,
  ).run(platform, account ?? null).changes;
}
