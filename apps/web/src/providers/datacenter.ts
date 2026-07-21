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
  try {
    const resp = await fetch(`${ROOT}/${encodeURIComponent(tableKey)}/records`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as DatacenterRecordListResponse;
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
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
