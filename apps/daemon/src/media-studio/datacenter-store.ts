// 飞书数据中心 · 应用内本地库(App 为主)的读写。
//
// 通用记录存储:datacenter_records 一张表存全 10 张逻辑表,字段异构存 JSON。
// 字段 key = 中文字段名(= 飞书列名,见 packages/contracts datacenter schema)。
// 写入前按 schema 过滤未知字段、拒写只读字段、按类型收敛值——脏数据进不来。
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  datacenterTableByKey,
  type DatacenterField,
  type DatacenterRecord,
  type DatacenterSyncState,
} from '@open-design/contracts';

interface Row {
  id: string;
  table_key: string;
  fields_json: string;
  feishu_record_id: string | null;
  sync_state: string;
  sync_error: string | null;
  updated_at: number;
}

function rowToRecord(r: Row): DatacenterRecord {
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.fields_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
    /* 坏 JSON 当空 */
  }
  const syncState: DatacenterSyncState =
    r.sync_state === 'synced' || r.sync_state === 'error' ? r.sync_state : 'local';
  return {
    id: r.id,
    tableKey: r.table_key,
    fields,
    ...(r.feishu_record_id ? { feishuRecordId: r.feishu_record_id } : {}),
    syncState,
    ...(r.sync_error ? { syncError: r.sync_error } : {}),
    updatedAt: r.updated_at,
  };
}

/** 按字段类型把用户传入的值收敛成规范形态(脏值宁可丢弃/置空,不写进库)。 */
function coerceValue(field: DatacenterField, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'multi_select':
      if (Array.isArray(raw)) return raw.map((v) => String(v)).filter((v) => v.length > 0);
      // 允许 "a,b,c" / "a、b" 逗号顿号分隔的字符串
      return String(raw)
        .split(/[,、，]/)
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    case 'datetime': {
      if (typeof raw === 'number') return raw;
      const t = Date.parse(String(raw));
      return Number.isFinite(t) ? t : String(raw); // 存不成时间戳就原样留字符串
    }
    default:
      // text / single_select / link / user / attachment / auto_number / formula → 字符串化
      return typeof raw === 'string' ? raw : String(raw);
  }
}

/**
 * 按 schema 过滤 + 收敛用户提交的字段:
 *  - 未知字段(不在 schema)直接丢
 *  - readonly 字段(auto_number/formula 等)不接受写入
 *  - 其余按类型 coerce;undefined 的不落 key
 * 表键非法则抛错(路由层转 404/400)。
 */
export function sanitizeDatacenterFields(tableKey: string, input: Record<string, unknown>): Record<string, unknown> {
  const table = datacenterTableByKey(tableKey);
  if (!table) throw new Error(`未知数据中心表:${tableKey}`);
  const out: Record<string, unknown> = {};
  for (const field of table.fields) {
    if (field.readonly) continue;
    if (!(field.name in input)) continue;
    const v = coerceValue(field, input[field.name]);
    if (v !== undefined) out[field.name] = v;
  }
  return out;
}

export function listDatacenterRecords(db: Database.Database, tableKey: string): DatacenterRecord[] {
  const rows = db
    .prepare(`SELECT * FROM datacenter_records WHERE table_key = ? ORDER BY updated_at DESC`)
    .all(tableKey) as Row[];
  return rows.map(rowToRecord);
}

export function getDatacenterRecord(db: Database.Database, id: string): DatacenterRecord | null {
  const row = db.prepare(`SELECT * FROM datacenter_records WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * 新建一条本地记录(sync_state=local,待推飞书)。字段已 sanitize。
 */
export function createDatacenterRecord(
  db: Database.Database,
  tableKey: string,
  fields: Record<string, unknown>,
): DatacenterRecord {
  const clean = sanitizeDatacenterFields(tableKey, fields);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO datacenter_records (id, table_key, fields_json, feishu_record_id, sync_state, sync_error, updated_at)
     VALUES (?, ?, ?, NULL, 'local', NULL, ?)`,
  ).run(id, tableKey, JSON.stringify(clean), Date.now());
  return getDatacenterRecord(db, id)!;
}

/**
 * 更新一条本地记录(合并字段;改动后回落 sync_state=local 等重推)。返回 null=不存在。
 */
export function updateDatacenterRecord(
  db: Database.Database,
  id: string,
  fields: Record<string, unknown>,
): DatacenterRecord | null {
  const existing = getDatacenterRecord(db, id);
  if (!existing) return null;
  const clean = sanitizeDatacenterFields(existing.tableKey, fields);
  const merged = { ...existing.fields, ...clean };
  db.prepare(
    `UPDATE datacenter_records SET fields_json = ?, sync_state = 'local', sync_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(merged), Date.now(), id);
  return getDatacenterRecord(db, id);
}

/** 删除本地记录;返回它的飞书 record_id(供路由层同步删飞书)。 */
export function deleteDatacenterRecord(
  db: Database.Database,
  id: string,
): { ok: boolean; tableKey?: string; feishuRecordId?: string } {
  const existing = getDatacenterRecord(db, id);
  if (!existing) return { ok: false };
  db.prepare(`DELETE FROM datacenter_records WHERE id = ?`).run(id);
  return {
    ok: true,
    tableKey: existing.tableKey,
    ...(existing.feishuRecordId ? { feishuRecordId: existing.feishuRecordId } : {}),
  };
}

/** 飞书推送成功:回写 record_id + sync_state=synced。 */
export function markDatacenterSynced(db: Database.Database, id: string, feishuRecordId: string): void {
  db.prepare(
    `UPDATE datacenter_records SET feishu_record_id = ?, sync_state = 'synced', sync_error = NULL WHERE id = ?`,
  ).run(feishuRecordId, id);
}

/** 飞书推送失败:记 sync_state=error + 错误摘要(不阻塞本地写入)。 */
export function markDatacenterSyncError(db: Database.Database, id: string, error: string): void {
  db.prepare(`UPDATE datacenter_records SET sync_state = 'error', sync_error = ? WHERE id = ?`).run(
    error.slice(0, 300),
    id,
  );
}
