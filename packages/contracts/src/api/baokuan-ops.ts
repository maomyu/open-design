// 爆款引擎·运维面 DTO(模块9/10,验收11/13):成本报表 / 失败队列 / 备份 / 开机自启。
// daemon /api/baokuan/{cost,failed,retry,backup,autostart} 与 web 运维卡片、od baokuan CLI 共用。

export interface BaokuanCostByKind {
  kind: string; // llm | asr | image | tikhub
  calls: number;
  units: number; // llm=tokens 总数;asr/tikhub=次数;image=张数
}

export interface BaokuanCostByDay {
  date: string;
  kind: string;
  units: number;
}

export interface BaokuanCostReport {
  days: number;
  by_kind: BaokuanCostByKind[];
  by_day: BaokuanCostByDay[];
}

export interface BaokuanFailedTask {
  id: number;
  ts: number;
  kind: string; // link | keyword | account | regenerate | candidate
  payload: Record<string, unknown>;
  reason: string;
  status: string;
}

export interface BaokuanRetryResult {
  ok: boolean;
  retried: number;
  results: Array<{ id: number; kind: string; ok: boolean; summary: string }>;
}

export interface BaokuanBackupResult {
  ok: boolean;
  path: string;
  bytes: number;
  included: string[];
  note?: string;
}

export interface BaokuanAutostartStatus {
  enabled: boolean;
  plist?: string;
  appBundle?: string | null;
}
