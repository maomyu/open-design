// 飞书数据中心（爆创·自媒体定制）
//
// 客户装机三步：① 连接【自己的】飞书(lark-cli device-flow,客户点链接用自己飞书授权)
// → ② 平台用 lark-cli 在【客户账户下】一键建好 10 表数据中心(provision) → ③ 内置浏览器打开。
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

  // 【全程自动推进】未连上时每 3.5s 轮询 status,由它驱动界面一步步往前走,客户不用点
  // 任何"下一步":建应用中 → 应用建好自动切到「本人登录」链接 → 授权后自动变绿。连上即停。
  useEffect(() => {
    if (connected) return;
    const id = window.setInterval(async () => {
      try {
        const st = await fetch('/api/feishu/connect/status').then((r) => r.json());
        if (st?.larkInstalled === false) { setLarkInstalled(false); return; }
        setLarkInstalled(true);
        if (st?.connected) {
          setConnected(true); setAuthUrl(''); setAuthCode('');
          setMsg('已连接你的飞书 ✓ 现在可以「创建数据中心」了。');
          return;
        }
        // 应用已建好、进入「本人登录」阶段 → 自动把链接切成登录链接(无需用户点)。
        if (st?.stage === 'login' && st?.loginUrl) {
          setAuthUrl(st.loginUrl); setAuthCode(st.userCode || '');
          setMsg('最后一步·本人登录:点下面链接用你的飞书登录授权 —— 授权后自动变绿,无需再点任何按钮。');
        }
      } catch { /* 轮询失败忽略,下次再试 */ }
    }, 3500);
    return () => window.clearInterval(id);
  }, [connected]);

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
      setMsg(d.stage === 'login'
        ? '点下面链接,用【你自己的】飞书登录授权 —— 授权后界面自动变绿,不用点任何按钮。'
        : '第①步·建应用:点下面链接,用【你自己的】飞书「创建应用并授权」。建好后界面会【自动】跳到「本人登录」链接,你只管在飞书里点授权,全程不用点「我已授权」。');
    } finally { setBusy(''); }
  }
  async function completeConnect() {
    setBusy('complete'); setMsg('正在确认授权（授权后稍等几秒）…');
    try {
      const r = await fetch('/api/feishu/connect/complete', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || '确认授权失败,请重新连接'); return; }
      // 建应用完成后还差第二步「本人登录」:后端回 needLogin + 新链接(后台已在轮询)。
      if (d.needLogin && d.url) {
        setAuthUrl(d.url); setAuthCode(d.userCode || '');
        setMsg(d.message || '最后一步:用你的飞书打开链接登录授权 —— 授权后界面自动变绿,无需再点。');
        return;
      }
      // 后台正在等你在飞书里点授权:保持链接、别清,让 4s 轮询自动收尾。
      if (d.waiting) {
        setMsg(d.message || '正在等你在飞书里点「授权」…授权后界面会自动变绿,不用再点。');
        return;
      }
      setConnected(true); setAuthUrl(''); setAuthCode(''); setMsg('已连接你的飞书 ✓');
    } finally { setBusy(''); }
  }
  async function provision() {
    setBusy('provision'); setMsg('正在你的飞书里创建数据中心（10 张表，约 1 分钟）…');
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
          <button type="button" className="plugin-edit-view__step-link" onClick={completeConnect} disabled={busy === 'complete'} title="通常不用点,授权后界面会自动变绿;点它只是手动催一下">
            {busy === 'complete' ? '刷新中…' : '刷新一下'}
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
          {busy === 'provision' ? '创建中…' : '在我的飞书创建数据中心（10 表）'}
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
