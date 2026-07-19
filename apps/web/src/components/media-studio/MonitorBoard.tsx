// 状态监控面板(W7):多账号运营健康看板——登录态 + 今日风控名额 + 今日互动战果,按平台分组。
// 把 W1(风控台账)+W6(登录保活)+互动审计汇成一屏,运营一眼看清"哪个号能发、发了多少、掉没掉线"。
// 数据源 /api/media-studio/monitor(与 od studio monitor 同端点);30s 轮询 + 每账号手动「检测」。
import { useCallback, useEffect, useState } from 'react';
import type { MonitorAccount } from '@open-design/contracts';
import { Icon } from '../Icon';
import { fetchMonitor, requestLoginCheck, openStudioBrowser } from '../../providers/media-studio';
import { BROWSER_PLATFORM_TITLES } from '../../runtime/browser-panes';
import { LOGIN_HOME } from '../../runtime/login-markers';
import { studioToast } from './StudioFeedback';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';
const keyOf = (platform: string, account: string): string => `${platform}::${account}`;

function quotaBlockText(reason?: string): string {
  return reason === 'cooldown' ? '冷却中' : reason === 'quiet-hours' ? '静默时段' : reason === 'daily-cap' ? '今日已满' : '受限';
}

export function MonitorBoard(): JSX.Element {
  const [items, setItems] = useState<MonitorAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const r = await fetchMonitor();
    setItems(r.items);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function check(platform: string, account: string): Promise<void> {
    const k = keyOf(platform, account);
    setChecking((m) => ({ ...m, [k]: true }));
    const r = await requestLoginCheck(platform, account);
    if ('error' in r) { studioToast.err(`检测失败：${r.error}`); setChecking((m) => ({ ...m, [k]: false })); return; }
    // 桌面端探测约 5-10s;轮询刷新几轮把最新登录态拉回来。
    for (let i = 0; i < 8; i++) { await new Promise((res) => setTimeout(res, 1500)); await refresh(); }
    setChecking((m) => ({ ...m, [k]: false }));
  }

  async function reLogin(platform: string, account: string): Promise<void> {
    const url = LOGIN_HOME[platform];
    const r = await openStudioBrowser({ platform, account, ...(url ? { url } : {}) });
    studioToast[r.error ? 'err' : 'ok'](r.error ? `打开失败：${r.error}` : `已打开「${account}」浏览器,请扫码补登`);
  }

  // 按平台分组(多账号分组)。
  const byPlatform = new Map<string, MonitorAccount[]>();
  for (const it of items) {
    const list = byPlatform.get(it.platform) ?? [];
    list.push(it);
    byPlatform.set(it.platform, list);
  }

  return (
    <div className={c('card')}>
      <div className={c('cardLabel')}>
        📊 健康看板
        <span className={c('cardHint')}>各账号登录态 + 今日风控名额 + 今日互动战果(发/拦/败)。掉线可一键去补登;名额满/冷却/静默会自动歇。每 30s 刷新。</span>
      </div>
      {loading ? (
        <div className={c('cardHint')}>加载中…</div>
      ) : items.length === 0 ? (
        <div className={c('cardHint')}>还没有扫码登录账号——去「账号」页添加并登录。</div>
      ) : (
        [...byPlatform.entries()].map(([platform, accounts]) => (
          <div key={platform} style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.7, margin: '6px 0 2px' }}>
              {BROWSER_PLATFORM_TITLES[platform] ?? platform}
            </div>
            {accounts.map((a) => {
              const k = keyOf(platform, a.account);
              const st = a.login?.state ?? 'unknown';
              const chipCls = st === 'logged-in' ? 'chipGreen' : st === 'logged-out' ? 'chipRed' : 'chipGrey';
              const chipTxt = st === 'logged-in' ? '已登录' : st === 'logged-out' ? '已失效' : '未检测';
              return (
                <div key={k} className={c('row')} style={{ alignItems: 'center', gap: 10, padding: '4px 0', flexWrap: 'wrap' }}>
                  <span className={`${c('chip')} ${c(chipCls)}`}>{chipTxt}</span>
                  <b style={{ fontSize: 13 }}>{a.account}</b>
                  <span className={c('cardHint')} title="今日已用/单日上限(受风控台账门控)">
                    名额 {a.quota.usedToday}/{a.quota.dailyCap}{!a.quota.allowed ? `（${quotaBlockText(a.quota.reason)}）` : ''}
                  </span>
                  <span className={c('cardHint')} title="今日成功外发 / 被风控拦 / 执行失败">
                    今日 发{a.today.sent} · 拦{a.today.blocked} · 败{a.today.failed}
                  </span>
                  <button type="button" className={c('btn')} disabled={Boolean(checking[k])} onClick={() => void check(platform, a.account)}>
                    <Icon name={checking[k] ? 'spinner' : 'refresh'} size={12} /> {checking[k] ? '检测中…' : '检测'}
                  </button>
                  {st === 'logged-out' ? (
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void reLogin(platform, a.account)}>
                      <Icon name="external-link" size={12} /> 去补登
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
