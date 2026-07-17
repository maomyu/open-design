// 账号中心 — platform-level self-media account management (独立导航「账号」).
//
// Accounts belong to PLATFORMS (公众号/抖音/小红书/快手/B站/视频号), not
// plugins: the same 抖音号 serves the 抖音发布 entry AND the 短视频工作流
// matrix. Two platform kinds:
//   - api-credential (公众号): per-account AppID/Secret entered here.
//   - sau-login (其余): the account NAME doubles as the local sau `--account`
//     cookie profile; login happens via a QR window at run time, so this page
//     manages names + writing personas, not secrets.
// Credential VALUES never come back from the daemon — presence flags only.

import { useEffect, useState } from 'react';
import {
  MEDIA_PLATFORMS,
  type AccountProfileView,
  type MediaPlatformDef,
} from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { Toast } from './Toast';
import {
  fetchPlatformAccounts,
  savePlatformAccount,
  deletePlatformAccountApi,
} from '../providers/daemon';
import { openStudioBrowser } from '../providers/media-studio';
import './AccountsView.css';
import './PluginEditView.css';

interface Draft {
  id?: string;
  name: string;
  persona: string;
  samplesText: string;
  credentials: Record<string, string>;
}

const EMPTY_DRAFT: Draft = { name: '', persona: '', samplesText: '', credentials: {} };

// 各平台【登录用主站】URL:比发布上传深页更适合登录(有清楚的「登录」入口),且和采集
// 访问的是同一域名——扫码登录后 cookie 落在 .douyin.com 等主域,采集/发布共用同一登录态。
// 没映射的平台退回默认后台 URL(daemon /browser/urls)。
const PLATFORM_LOGIN_URLS: Record<string, string> = {
  douyin: 'https://www.douyin.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/',
  // 快手登【创作者中心】:www.kuaishou.com 在 webview 里会返回 JSON 接口响应,不是登录页;
  // cp.kuaishou.com 会重定向到 passport 扫码登录页,且正是发布(cp.kuaishou.com)要的登录态。
  kuaishou: 'https://cp.kuaishou.com/',
  bilibili: 'https://www.bilibili.com/',
  shipinhao: 'https://channels.weixin.qq.com/',
  tencent: 'https://channels.weixin.qq.com/',
  'wechat-mp': 'https://mp.weixin.qq.com/',
  zhihu: 'https://www.zhihu.com/',
  weibo: 'https://weibo.com/',
};

export function AccountsView() {
  const { t } = useI18n();
  const [byPlatform, setByPlatform] = useState<Record<string, AccountProfileView[]>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  async function refresh() {
    const data = await fetchPlatformAccounts();
    if (data) {
      const map: Record<string, AccountProfileView[]> = {};
      for (const p of data.platforms) map[p.id] = p.accounts;
      setByPlatform(map);
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="accounts-view" aria-labelledby="accounts-title">
      <header className="accounts-view__hero">
        <div>
          <p className="plugins-view__kicker">{t('entry.navAccounts')}</p>
          <h1 id="accounts-title" className="entry-section__title">
            {t('accountsView.title')}
          </h1>
          <p className="plugins-view__lede">{t('accountsView.lede')}</p>
        </div>
      </header>

      {/* ── 数据源 ──
          选题采集用 TikHub 内置数据源(无需在此配置或登录)。 */}
      <div style={{ margin: '4px 0 8px' }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>📊 数据源</div>
        <div style={{ fontSize: 12.5, opacity: 0.72, marginTop: 2 }}>
          选题采集已用 <b>TikHub</b> 内置数据源(带粉丝/点赞/评论,无需登录)。
        </div>
      </div>

      {/* ── 发布账号 ──
          各平台登录只为【发布】(一键存草稿/发送)和下载原视频用,不用于选题采集。 */}
      <div style={{ margin: '18px 0 8px', borderTop: '1px solid var(--od-border, #ececec)', paddingTop: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>📤 发布账号</div>
        <div style={{ fontSize: 12.5, opacity: 0.72, marginTop: 2 }}>
          在这里登录各平台,用于<b>发布(一键存草稿/发送)</b>和下载原视频。<b>选题采集不需要登录</b>——那一步走 TikHub。
        </div>
      </div>

      {loading ? (
        <div className="plugins-view__empty">{t('pluginsView.loading')}</div>
      ) : (
        <div className="accounts-view__platforms">
          {MEDIA_PLATFORMS.map((platform) => (
            <PlatformCard
              key={platform.id}
              platform={platform}
              accounts={byPlatform[platform.id] ?? []}
              onChanged={async (msg) => {
                if (msg) setToast(msg);
                await refresh();
              }}
            />
          ))}
        </div>
      )}
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </section>
  );
}

function PlatformCard({
  platform,
  accounts,
  onChanged,
}: {
  platform: MediaPlatformDef;
  accounts: AccountProfileView[];
  onChanged: (toast: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const credKeys = platform.credentialKeys ?? [];

  function beginAdd() {
    setSaveError(null);
    setDraft({ ...EMPTY_DRAFT, credentials: {} });
  }
  function beginEdit(a: AccountProfileView) {
    setSaveError(null);
    setDraft({
      id: a.id,
      name: a.name,
      persona: a.style?.persona ?? '',
      samplesText: (a.style?.samples ?? []).join('\n\n'),
      credentials: {},
    });
  }

  async function save() {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    const samples = draft.samplesText
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const credentials: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.credentials)) {
      if (typeof v === 'string' && v.trim()) credentials[k] = v.trim();
    }
    const result = await savePlatformAccount(platform.id, {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      style: { persona: draft.persona.trim(), samples },
      ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    });
    setSaving(false);
    if ('error' in result) {
      setSaveError(result.error);
      return;
    }
    setDraft(null);
    await onChanged(t('pluginEditor.accountSaved'));
  }

  async function remove(id: string) {
    const ok = await deletePlatformAccountApi(platform.id, id);
    if (ok) await onChanged(null);
  }

  return (
    <article
      className="accounts-view__platform"
      data-testid={`accounts-platform-${platform.id}`}
      aria-label={platform.title}
    >
      <header className="accounts-view__platform-head">
        <h2>{platform.title}</h2>
        <span className="accounts-view__platform-kind">
          {platform.kind === 'api-credential'
            ? t('accountsView.kindApi')
            : t('accountsView.kindSau')}
        </span>
        <span className="accounts-view__platform-count">{accounts.length}</span>
      </header>

      {accounts.length === 0 && !draft ? (
        <p className="accounts-view__empty">{t('accountsView.platformEmpty')}</p>
      ) : (
        <div className="accounts-view__list">
          {accounts.map((a) => (
            <div
              className="plugin-edit-view__account-card"
              key={a.id}
              data-testid={`accounts-${platform.id}-${a.id}`}
            >
              <div className="plugin-edit-view__account-head">
                <span className="plugin-edit-view__account-name">{a.name}</span>
                <code className="plugin-edit-view__account-id">{a.id}</code>
                <div className="plugin-edit-view__account-actions">
                  {/* 内置浏览器常驻入口(2026-07-09 用户问"怎么打开"——原先只
                      藏在三台的发布步骤里)。档案按 平台×账号 隔离,登录态长期
                      保持;桌面端开内置窗口,网页端降级拉独立 Chrome 档案。
                      中文直写不进 i18n,与创作台惯例一致(客户定制)。 */}
                  <button
                    type="button"
                    className="plugin-edit-view__step-link"
                    title="打开该账号的专属浏览器登录该平台（用于【发布】一键存草稿 + 下载原视频的登录态；档案隔离，扫码登录一次长期保持，多号不串。选题采集已改走 TikHub，不需要登录）"
                    onClick={async () => {
                      // 用【平台主站登录页】而不是发布上传深页:主站有清楚的「登录」入口,
                      // 且和采集访问的是同一域名(cookie 落在 .douyin.com 等,采集直接复用登录态)。
                      // 主站没映射的平台退回默认后台 URL(daemon /browser/urls)。
                      const loginUrl = PLATFORM_LOGIN_URLS[platform.id];
                      const r = await openStudioBrowser({ platform: platform.id, account: a.name, ...(loginUrl ? { url: loginUrl } : {}) });
                      await onChanged(r.error ? `专属浏览器打开失败：${r.error}` : `已打开「${a.name}」专属浏览器——请在里面扫码登录${platform.title}`);
                    }}
                  >
                    <Icon name="external-link" size={12} />
                    <span>打开登录</span>
                  </button>
                  <button
                    type="button"
                    className="plugin-edit-view__step-link"
                    onClick={() => beginEdit(a)}
                  >
                    <Icon name="edit" size={12} />
                    <span>{t('pluginEditor.accountEdit')}</span>
                  </button>
                  <button
                    type="button"
                    className="plugin-edit-view__step-link plugin-edit-view__step-link--danger"
                    onClick={() => void remove(a.id)}
                  >
                    <Icon name="trash" size={12} />
                    <span>{t('pluginEditor.accountDelete')}</span>
                  </button>
                </div>
              </div>
              {a.style?.persona ? (
                <p className="plugin-edit-view__account-persona">{a.style.persona}</p>
              ) : null}
              {credKeys.length > 0 ? (
                <div className="plugin-edit-view__account-creds">
                  {credKeys.map((k) => (
                    <span
                      key={k.name}
                      title={k.name}
                      className={`plugin-edit-view__account-cred${a.credentials[k.name] ? ' is-set' : ''}`}
                    >
                      {k.label}
                      {a.credentials[k.name] ? ` · ${t('pluginEditor.configSet')}` : ''}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="plugin-edit-view__account-form" data-testid={`accounts-form-${platform.id}`}>
          <label className="plugin-edit-view__account-field">
            <span>{t('pluginEditor.accountName')}</span>
            <input
              className="plugin-edit-view__account-input"
              value={draft.name}
              disabled={saving}
              placeholder={
                platform.kind === 'sau-login'
                  ? t('accountsView.sauNamePlaceholder')
                  : t('pluginEditor.accountNamePlaceholder')
              }
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          {platform.kind === 'sau-login' ? (
            <p className="accounts-view__sau-hint">{t('accountsView.sauHint')}</p>
          ) : null}
          <label className="plugin-edit-view__account-field">
            <span>{t('pluginEditor.accountPersona')}</span>
            <textarea
              className="plugin-edit-view__account-textarea"
              value={draft.persona}
              disabled={saving}
              spellCheck={false}
              placeholder={t('pluginEditor.accountPersonaHint')}
              onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
            />
          </label>
          <label className="plugin-edit-view__account-field">
            <span>{t('pluginEditor.accountSamples')}</span>
            <textarea
              className="plugin-edit-view__account-textarea"
              value={draft.samplesText}
              disabled={saving}
              spellCheck={false}
              placeholder={t('pluginEditor.accountSamplesHint')}
              onChange={(e) => setDraft({ ...draft, samplesText: e.target.value })}
            />
          </label>
          {credKeys.length > 0 ? (
            <div className="plugin-edit-view__account-cred-inputs">
              <span className="plugin-edit-view__account-field-label">
                {t('pluginEditor.accountCredentials')}
              </span>
              <span className="plugin-edit-view__account-cred-hint">
                {t('pluginEditor.accountCredsHint')}
              </span>
              {credKeys.map((k) => {
                const isSet = Boolean(accounts.find((a) => a.id === draft.id)?.credentials[k.name]);
                return (
                  <label className="plugin-edit-view__account-field" key={k.name}>
                    <span>
                      {k.label}
                      <code className="plugin-edit-view__account-cred-key">{k.name}</code>
                    </span>
                    {k.description ? (
                      <span className="plugin-edit-view__account-cred-desc">{k.description}</span>
                    ) : null}
                    <input
                      type={k.secret ? 'password' : 'text'}
                      className="plugin-edit-view__account-input"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={saving}
                      placeholder={isSet ? '••••••  ·  ' + t('pluginEditor.configSet') : ''}
                      value={draft.credentials[k.name] ?? ''}
                      onChange={(e) =>
                        setDraft({ ...draft, credentials: { ...draft.credentials, [k.name]: e.target.value } })
                      }
                    />
                  </label>
                );
              })}
            </div>
          ) : null}
          {saveError ? (
            <div className="plugin-edit-view__account-error" role="alert">
              {t('pluginEditor.accountSaveFailed')}: {saveError}
            </div>
          ) : null}
          <div className="plugin-edit-view__account-form-foot">
            <button
              type="button"
              className="plugin-edit-view__config-save"
              disabled={saving || !draft.name.trim()}
              onClick={() => void save()}
            >
              {saving ? t('pluginEditor.publishing') : t('pluginEditor.accountSave')}
            </button>
            <button
              type="button"
              className="plugin-edit-view__step-link"
              disabled={saving}
              onClick={() => {
                setSaveError(null);
                setDraft(null);
              }}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="plugin-edit-view__config-save"
          onClick={beginAdd}
          data-testid={`accounts-add-${platform.id}`}
        >
          <Icon name="plus" size={12} />
          <span>{t('pluginEditor.accountAdd')}</span>
        </button>
      )}
    </article>
  );
}
