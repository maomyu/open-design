// 飞书数据中心（爆创·自媒体定制）
//
// 客户装机三步：① 连接【自己的】飞书(lark-cli device-flow,客户点链接用自己飞书授权)
// → ② 平台用 lark-cli 在【客户账户下】一键建好 12 表数据中心(provision) → ③ 内置浏览器打开。
// 数据全在客户自己飞书名下,与开发者账号无关。URL 存 app-config.feishuBitableUrl(仅本机)。
import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { openStudioBrowser } from '../providers/media-studio';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function FeishuDataCenterSection() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [connected, setConnected] = useState(false);
  const [larkInstalled, setLarkInstalled] = useState(true);
  const [authUrl, setAuthUrl] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  async function loadStatus() {
    try {
      const [cfg, st] = await Promise.all([
        fetch('/api/app-config').then((r) => r.json()).catch(() => ({})),
        fetch('/api/feishu/connect/status').then((r) => r.json()).catch(() => ({})),
      ]);
      setUrl((cfg?.config?.feishuBitableUrl as string) ?? '');
      setConnected(Boolean(st?.connected));
      setLarkInstalled(st?.larkInstalled !== false);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void loadStatus(); }, []);

  async function saveUrl(u: string) {
    setSaveStatus('saving');
    try {
      const resp = await fetch('/api/app-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feishuBitableUrl: u.trim() || null }),
      });
      if (!resp.ok) throw new Error();
      setSaveStatus('saved');
      window.setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  }

  async function startConnect() {
    setBusy('connect'); setMsg(''); setAuthUrl(''); setAuthCode('');
    try {
      const r = await fetch('/api/feishu/connect/start', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || '发起连接失败'); return; }
      if (d.connected) { setConnected(true); setMsg('已连接你的飞书 ✓'); return; }
      setAuthUrl(d.url); setAuthCode(d.userCode || '');
      setMsg('点下面链接,用【你自己的】飞书打开,按飞书页面「创建应用并授权」,然后回来点「我已授权」。');
    } finally { setBusy(''); }
  }
  async function completeConnect() {
    setBusy('complete'); setMsg('正在确认授权（授权后稍等几秒）…');
    try {
      const r = await fetch('/api/feishu/connect/complete', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || '确认授权失败,请重新连接'); return; }
      setConnected(true); setAuthUrl(''); setMsg('已连接你的飞书 ✓');
    } finally { setBusy(''); }
  }
  async function provision() {
    setBusy('provision'); setMsg('正在你的飞书里创建数据中心（12 张表，约 1 分钟）…');
    try {
      const r = await fetch('/api/feishu/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '自媒体爆款数据中心' }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || '创建失败'); return; }
      setUrl(d.url); setMsg('数据中心已在你的飞书里创建 ✓ 可点下方「打开」查看。');
    } finally { setBusy(''); }
  }
  async function open() {
    const u = url.trim();
    if (!u) return;
    setMsg('正在用内置浏览器打开…');
    const r = await openStudioBrowser({ platform: 'feishu', account: 'main', url: u });
    setMsg(r.error ? `打开失败：${r.error}` : '已在内置浏览器打开（首次请登录你的飞书）');
  }

  const stepStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' };
  const numStyle: CSSProperties = { width: 22, height: 22, borderRadius: 11, background: '#e8582e', color: '#fff', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' };

  return (
    <section
      className="settings-section"
      data-testid="feishu-data-center-section"
      style={{ border: '1px solid var(--od-border, #e3e3e6)', borderRadius: 14, padding: '18px 20px', background: 'var(--od-surface, #fafafa)' }}
    >
      <header style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="grid" size={18} /> 飞书数据中心
        </h3>
        <p style={{ opacity: 0.72, fontSize: 13, lineHeight: 1.6, marginTop: 6 }}>
          连接<b>你自己的</b>飞书,平台会在<b>你的账户下</b>建好这套多维表格。采集/评分/脚本/复盘等数据都沉淀在你自己名下,手机随时看、审核、复盘,和开发者账号无关。
        </p>
      </header>

      {/* ① 连接飞书 */}
      <div style={stepStyle}>
        <span style={numStyle}>1</span>
        {connected ? (
          <span style={{ color: '#1a8f3c', fontWeight: 600 }}>✓ 已连接你的飞书</span>
        ) : (
          <button type="button" className="settings-primary-btn" onClick={startConnect} disabled={busy === 'connect' || !larkInstalled}>
            {busy === 'connect' ? '发起中…' : '连接飞书'}
          </button>
        )}
        {!connected && authUrl ? (
          <button type="button" className="plugin-edit-view__step-link" onClick={completeConnect} disabled={busy === 'complete'}>
            {busy === 'complete' ? '确认中…' : '我已授权'}
          </button>
        ) : null}
      </div>
      {!larkInstalled ? (
        <div style={{ margin: '2px 0 8px 32px', fontSize: 13, color: '#c0392b' }}>
          未检测到飞书命令行(lark-cli),请先安装后重启爆创再连接。
        </div>
      ) : null}
      {!connected && authUrl ? (
        <div style={{ margin: '2px 0 8px 32px', fontSize: 13 }}>
          <a href={authUrl} target="_blank" rel="noreferrer" style={{ color: '#e8582e', wordBreak: 'break-all' }}>
            👉 点此打开飞书官方页面（用你自己的飞书扫码/登录，按提示创建应用并授权）
          </a>
          {authCode ? <div style={{ opacity: 0.7, marginTop: 4 }}>配置码：{authCode}</div> : null}
        </div>
      ) : null}

      {/* ② 创建数据中心 */}
      <div style={stepStyle}>
        <span style={{ ...numStyle, background: connected ? '#e8582e' : '#bbb' }}>2</span>
        <button type="button" className="settings-primary-btn" onClick={provision} disabled={!connected || busy === 'provision'}>
          {busy === 'provision' ? '创建中…' : '在我的飞书创建数据中心（12 表）'}
        </button>
      </div>

      {/* ③ 打开 / 链接 */}
      <div style={stepStyle}>
        <span style={{ ...numStyle, background: url.trim() ? '#e8582e' : '#bbb' }}>3</span>
        <button type="button" className="plugin-edit-view__step-link" onClick={open} disabled={!url.trim()}>
          <Icon name="external-link" size={14} />
          <span>打开飞书数据中心</span>
        </button>
      </div>

      <label style={{ display: 'block', fontWeight: 600, margin: '12px 0 6px', fontSize: 13, opacity: 0.8 }}>
        飞书多维表格链接（创建后自动填入；也可手动粘贴已有的）
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={url}
          placeholder="https://你的域名.feishu.cn/base/xxxxxxxx"
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--od-border, #ddd)' }}
        />
        <button type="button" className="plugin-edit-view__step-link" onClick={() => saveUrl(url)} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已保存 ✓' : '保存'}
        </button>
      </div>

      {msg ? <p style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>{msg}</p> : null}
    </section>
  );
}
