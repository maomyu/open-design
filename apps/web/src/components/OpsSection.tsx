// 运维卡片(模块9/10,验收11/13):成本统计 / 失败队列+重试 / 一键备份 / 开机自启。
// 与 od baokuan cost/failed/retry/backup/autostart 同源同端点(/api/baokuan/*),
// 界面按钮=CLI 命令的等价物。挂在账号页 MonitorConfigSection 下方。
import { useEffect, useState, type JSX } from 'react';
import type { BaokuanCostReport, BaokuanFailedTask } from '@open-design/contracts';
import {
  backupBaokuan,
  fetchBaokuanAutostart,
  fetchBaokuanCost,
  fetchBaokuanFailed,
  retryBaokuanFailed,
  setBaokuanAutostart,
} from '../providers/daemon';

const KIND_LABEL: Record<string, string> = {
  llm: 'AI 文本(tokens)', asr: '语音转写(次)', image: '封面出图(张)', tikhub: '数据接口(次)',
};

export function OpsSection(): JSX.Element {
  const [cost, setCost] = useState<BaokuanCostReport | null>(null);
  const [failed, setFailed] = useState<BaokuanFailedTask[]>([]);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [c, f, a] = await Promise.all([
      fetchBaokuanCost(7), fetchBaokuanFailed(), fetchBaokuanAutostart(),
    ]);
    setCost(c);
    setFailed(f);
    setAutostart(a ? a.enabled : null);
  }
  useEffect(() => { void refresh(); }, []);

  async function onRetry(): Promise<void> {
    setBusy('retry');
    setNote(null);
    const r = await retryBaokuanFailed(5);
    setNote('error' in r && r.error ? `重试失败:${r.error}` : `重试完成:${(r as { retried: number }).retried} 条`);
    await refresh();
    setBusy(null);
  }
  async function onBackup(): Promise<void> {
    setBusy('backup');
    setNote(null);
    const r = await backupBaokuan();
    setNote('error' in r && r.error
      ? `备份失败:${r.error}`
      : `备份完成:${(r as { path: string }).path}(拷走此文件即可迁移新电脑)`);
    setBusy(null);
  }
  async function onToggleAutostart(): Promise<void> {
    setBusy('autostart');
    setNote(null);
    const r = await setBaokuanAutostart(!autostart);
    if (r.error) setNote(`开机自启配置失败:${r.error}`);
    else setNote(r.enabled ? '已开启开机自启(下次登录自动启动)' : '已关闭开机自启');
    await refresh();
    setBusy(null);
  }

  return (
    <div className="ops-section" style={{ marginBottom: 18 }}>
      <div style={{ margin: '4px 0 8px' }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>🛠 运维 · 成本 / 失败重试 / 备份 / 自启</div>
        <div style={{ fontSize: 12.5, opacity: 0.72, marginTop: 2 }}>
          近 7 天接口成本、失败任务队列(失败不丢,一键重跑)、数据一键备份、开机自启。
        </div>
      </div>
      {note ? (
        <p style={{ fontSize: 12.5, color: 'var(--od-accent, #2b7)', margin: '0 0 8px', wordBreak: 'break-all' }}>{note}</p>
      ) : null}

      <div className="plugin-edit-view__account-card">
        <div className="plugin-edit-view__account-head">
          <span className="plugin-edit-view__account-name">💰 近 7 天成本</span>
        </div>
        <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 18px', padding: '2px 0 4px' }}>
          {(cost?.by_kind ?? []).length === 0 ? <span style={{ opacity: 0.6 }}>暂无调用记录</span> : null}
          {(cost?.by_kind ?? []).map((k) => (
            <span key={k.kind}>{KIND_LABEL[k.kind] ?? k.kind}: <b>{k.units.toLocaleString()}</b>(共 {k.calls} 次)</span>
          ))}
        </div>
      </div>

      <div className="plugin-edit-view__account-card">
        <div className="plugin-edit-view__account-head">
          <span className="plugin-edit-view__account-name">
            {failed.length ? '🔴' : '🟢'} 失败队列 {failed.length ? `· ${failed.length} 条待重试` : '· 无积压'}
          </span>
          <div className="plugin-edit-view__account-actions">
            {failed.length ? (
              <button type="button" className="plugin-edit-view__step-link" disabled={busy === 'retry'} onClick={() => void onRetry()}>
                {busy === 'retry' ? '重试中…' : '重跑失败任务'}
              </button>
            ) : null}
          </div>
        </div>
        {failed.slice(0, 5).map((f) => (
          <div key={f.id} style={{ fontSize: 12.5, opacity: 0.8, padding: '1px 0' }}>
            #{f.id} [{f.kind}] {f.reason?.slice(0, 70)}
          </div>
        ))}
      </div>

      <div className="plugin-edit-view__account-card">
        <div className="plugin-edit-view__account-head">
          <span className="plugin-edit-view__account-name">🧳 备份与迁移 / 开机自启</span>
          <div className="plugin-edit-view__account-actions">
            <button type="button" className="plugin-edit-view__step-link" disabled={busy === 'backup'} onClick={() => void onBackup()}>
              {busy === 'backup' ? '备份中…' : '一键备份'}
            </button>
            <button type="button" className="plugin-edit-view__step-link" disabled={busy === 'autostart' || autostart === null} onClick={() => void onToggleAutostart()}>
              {autostart === null ? '自启:不可用' : autostart ? '关闭开机自启' : '开启开机自启'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12.5, opacity: 0.7 }}>
          备份含:引擎数据(去重库/成本台账/失败队列)+ 全部配置 Key + 应用数据(知识库/文章/账号)。
        </div>
      </div>
    </div>
  );
}
