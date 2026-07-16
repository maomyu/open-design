// 飞书数据中心·定时监控配置(块3):把爆款引擎定时自动抓的关键词/竞品账号 + 全局参数
// 做成界面可维护,写进飞书「监控配置库/系统配置表」。引擎 run_scheduled 读监控配置库、
// config_sync 读系统配置表。照搬 AccountsView.PlatformCard 的增删改范式,复用其 CSS class。
import { useEffect, useState, type JSX } from 'react';
import {
  MONITOR_PLATFORM_LABELS,
  MONITOR_TIME_WINDOWS,
  MONITOR_CATEGORIES,
  type MonitorConfigRow,
  type SystemConfigRow,
} from '@open-design/contracts';
import {
  fetchMonitorConfigs,
  saveMonitorConfig,
  deleteMonitorConfig,
  fetchSystemConfigs,
  saveSystemConfig,
} from '../providers/daemon';

const EMPTY_MONITOR: MonitorConfigRow = { type: '关键词', keyword: '', platforms: [], enabled: true };

export function MonitorConfigSection(): JSX.Element {
  const [rows, setRows] = useState<MonitorConfigRow[]>([]);
  const [sysRows, setSysRows] = useState<SystemConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<MonitorConfigRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    const [m, s] = await Promise.all([fetchMonitorConfigs(), fetchSystemConfigs()]);
    setRows(m);
    setSysRows(s);
    setLoading(false);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function saveDraft(): Promise<void> {
    if (!draft || !draft.keyword.trim() || saving) return;
    setSaving(true);
    setErr(null);
    const r = await saveMonitorConfig({ ...draft, keyword: draft.keyword.trim() });
    setSaving(false);
    if ('error' in r) {
      setErr(r.error);
      return;
    }
    setDraft(null);
    setNote('已保存到飞书「监控配置库」');
    await refresh();
  }

  async function removeRow(recordId?: string): Promise<void> {
    if (!recordId) return;
    if (await deleteMonitorConfig(recordId)) {
      setNote('已删除该监控项');
      await refresh();
    }
  }

  function togglePlatform(p: string): void {
    if (!draft) return;
    const has = draft.platforms.includes(p);
    setDraft({ ...draft, platforms: has ? draft.platforms.filter((x) => x !== p) : [...draft.platforms, p] });
  }

  async function saveSys(row: SystemConfigRow, value: string, enabled: boolean): Promise<void> {
    const r = await saveSystemConfig({ ...row, value, enabled });
    if ('error' in r) {
      setErr(r.error);
      return;
    }
    setNote(`已更新「${row.item}」`);
    await refresh();
  }

  return (
    <div className="monitor-config-section" style={{ marginBottom: 18 }}>
      <div style={{ margin: '4px 0 8px' }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>🎯 定时监控 · 关键词 / 竞品</div>
        <div style={{ fontSize: 12.5, opacity: 0.72, marginTop: 2 }}>
          配置爆款引擎<b>定时自动抓</b>的关键词 / 竞品账号,写进飞书「监控配置库」——勾选<b>启用</b>后引擎每隔一段时间自动跑一轮采集评分,选题沉淀到数据中心。
        </div>
      </div>
      {note ? (
        <p style={{ fontSize: 12.5, color: 'var(--od-accent, #2b7)', margin: '0 0 8px' }}>{note}</p>
      ) : null}

      {loading ? (
        <p className="accounts-view__empty">加载中…</p>
      ) : (
        <div className="accounts-view__list">
          {rows.length === 0 && !draft ? (
            <p className="accounts-view__empty">还没有监控项。加一条关键词或竞品账号,勾「启用」后引擎定时自动抓。</p>
          ) : null}
          {rows.map((row) => (
            <div className="plugin-edit-view__account-card" key={row.recordId}>
              <div className="plugin-edit-view__account-head">
                <span className="plugin-edit-view__account-name">
                  {row.enabled ? '🟢' : '⚪'} [{row.type}] {row.keyword}
                </span>
                <div className="plugin-edit-view__account-actions">
                  <button
                    type="button"
                    className="plugin-edit-view__step-link"
                    onClick={() => {
                      setErr(null);
                      setDraft(row);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="plugin-edit-view__step-link plugin-edit-view__step-link--danger"
                    onClick={() => void removeRow(row.recordId)}
                  >
                    删除
                  </button>
                </div>
              </div>
              <p className="plugin-edit-view__account-persona">
                平台:{row.platforms.join('、') || '全平台'}
                {row.type === '关键词'
                  ? ` · 最低热度 ${row.minThreshold ?? 0}`
                  : ` · 时间窗 ${row.timeWindow || '7d'}`}
                {row.enabled ? '' : ' · (未启用)'}
              </p>
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="plugin-edit-view__account-form">
          <label className="plugin-edit-view__account-field">
            <span>类型</span>
            <select
              className="plugin-edit-view__account-input"
              value={draft.type}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as MonitorConfigRow['type'] })}
            >
              <option value="关键词">关键词</option>
              <option value="竞品账号">竞品账号</option>
            </select>
          </label>
          <label className="plugin-edit-view__account-field">
            <span>{draft.type === '关键词' ? '关键词' : '竞品账号名 / 主页链接'}</span>
            <input
              className="plugin-edit-view__account-input"
              value={draft.keyword}
              disabled={saving}
              placeholder={draft.type === '关键词' ? '例:男性情感成长' : '例:某某情感博主 或 主页链接'}
              onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            />
          </label>
          <div className="plugin-edit-view__account-field">
            <span>平台(多选)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {MONITOR_PLATFORM_LABELS.map((p) => (
                <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={draft.platforms.includes(p)}
                    disabled={saving}
                    onChange={() => togglePlatform(p)}
                  />
                  {p}
                </label>
              ))}
            </div>
          </div>
          {draft.type === '关键词' ? (
            <label className="plugin-edit-view__account-field">
              <span>最低热度阈值(0 = 不限)</span>
              <input
                type="number"
                className="plugin-edit-view__account-input"
                value={draft.minThreshold ?? 0}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, minThreshold: Number(e.target.value) || 0 })}
              />
            </label>
          ) : (
            <label className="plugin-edit-view__account-field">
              <span>时间窗</span>
              <select
                className="plugin-edit-view__account-input"
                value={draft.timeWindow || '7d'}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, timeWindow: e.target.value })}
              >
                {MONITOR_TIME_WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="plugin-edit-view__account-field">
            <span>主题分类(可选)</span>
            <select
              className="plugin-edit-view__account-input"
              value={draft.category || ''}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              <option value="">(不分类)</option>
              {MONITOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: '6px 0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            <span>启用(引擎定时自动抓)</span>
          </label>
          {err ? <p style={{ color: 'var(--od-danger, #d33)', fontSize: 12.5 }}>{err}</p> : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="plugin-edit-view__config-save"
              disabled={saving || !draft.keyword.trim()}
              onClick={() => void saveDraft()}
            >
              {saving ? '保存中…' : '保存到飞书'}
            </button>
            <button
              type="button"
              className="plugin-edit-view__step-link"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setErr(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="plugin-edit-view__config-save"
          style={{ marginTop: 8 }}
          onClick={() => {
            setErr(null);
            setDraft({ ...EMPTY_MONITOR, platforms: [] });
          }}
        >
          + 加监控项
        </button>
      )}

      <div style={{ marginTop: 20, borderTop: '1px solid var(--od-border, #ececec)', paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>⚙️ 全局参数(系统配置表)</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2, marginBottom: 8 }}>
          引擎启动即读,改完下次跑生效:检测频率、各爆款阈值、TopK、默认模型。
        </div>
        {sysRows.length === 0 ? (
          <p className="accounts-view__empty">系统配置表为空——建好数据中心后会自动种子默认值。</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {sysRows.map((row) => (
              <SysConfigRow key={row.recordId || row.item} row={row} onSave={saveSys} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SysConfigRow({
  row,
  onSave,
}: {
  row: SystemConfigRow;
  onSave: (row: SystemConfigRow, value: string, enabled: boolean) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState(row.value);
  const [enabled, setEnabled] = useState(row.enabled);
  const [busy, setBusy] = useState(false);
  const dirty = value !== row.value || enabled !== row.enabled;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ width: 128, flexShrink: 0 }}>{row.item}</span>
      <input
        className="plugin-edit-view__account-input"
        style={{ flex: '0 0 128px' }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span style={{ opacity: 0.6, width: 40 }}>{row.unit || ''}</span>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用
      </label>
      <button
        type="button"
        className="plugin-edit-view__step-link"
        disabled={!dirty || busy}
        onClick={async () => {
          setBusy(true);
          await onSave(row, value, enabled);
          setBusy(false);
        }}
      >
        {busy ? '…' : '保存'}
      </button>
    </div>
  );
}
