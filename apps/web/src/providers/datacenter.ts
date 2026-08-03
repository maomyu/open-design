// 飞书数据中心 · 应用内镜像的 web 数据层。schema(10 表结构)静态来自 contracts
// (DATACENTER_TABLES),无需请求;这里只封装记录 CRUD + 同步飞书的 HTTP 调用。
import type {
  DatacenterRecord,
  DatacenterRecordListResponse,
  DatacenterRecordResponse,
  DatacenterSyncResponse,
} from '@open-design/contracts';

const ROOT = '/api/datacenter';

async function readError(resp: Response): Promise<string> {
  try {
    const data = (await resp.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    /* ignore */
  }
  return `请求失败 (${resp.status})`;
}

export async function fetchDatacenterRecords(tableKey: string): Promise<DatacenterRecord[]> {
  return (await fetchDatacenterRecordsResult(tableKey)).records;
}

/** 带错误的读取:引擎表是实时读飞书的,把"没连飞书/拉取失败"一律吞成空数组会让
 *  界面显示「暂无数据」——失败伪装成空态(2026-08-04 审计)。 */
export async function fetchDatacenterRecordsResult(
  tableKey: string,
): Promise<{ records: DatacenterRecord[]; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/records`);
    const raw = await resp.text().catch(() => '');
    let data: DatacenterRecordListResponse & { error?: string } = {} as never;
    try { data = raw ? JSON.parse(raw) : ({} as never); } catch { /* 非 JSON(HTML 500) */ }
    if (!resp.ok) return { records: [], error: (typeof data.error === 'string' && data.error) || `请求失败 (${resp.status})` };
    if (typeof data.error === 'string' && data.error) return { records: [], error: data.error };
    return { records: Array.isArray(data.records) ? data.records : [] };
  } catch (e) {
    return { records: [], error: e instanceof Error ? e.message : '读取失败' };
  }
}

export async function createDatacenterRecord(
  tableKey: string,
  fields: Record<string, unknown>,
): Promise<{ record?: DatacenterRecord; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!resp.ok) return { error: await readError(resp) };
    const data = (await resp.json()) as DatacenterRecordResponse;
    return { record: data.record };
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function updateDatacenterRecord(
  tableKey: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<{ record?: DatacenterRecord; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/records/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!resp.ok) return { error: await readError(resp) };
    const data = (await resp.json()) as DatacenterRecordResponse;
    return { record: data.record };
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function deleteDatacenterRecord(
  tableKey: string,
  id: string,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) return { error: await readError(resp) };
    return { ok: true };
  } catch {
    return { error: '连不上本地服务（daemon）' };
  }
}

export async function syncDatacenterTable(tableKey: string): Promise<DatacenterSyncResponse> {
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/sync`, { method: 'POST' });
    const data = (await resp.json().catch(() => ({}))) as DatacenterSyncResponse & { error?: string };
    if (!resp.ok) return { ok: false, synced: 0, failed: 0, error: data.error ?? `同步失败 (${resp.status})` };
    return data;
  } catch {
    return { ok: false, synced: 0, failed: 0, error: '连不上本地服务（daemon）' };
  }
}
