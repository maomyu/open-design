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
import './MediaHubView.css';
import './PluginEditView.css';

interface Draft {
  id?: string;
  name: string;
  persona: string;
  samplesText: string;
  credentials: Record<string, string>;
}

const EMPTY_DRAFT: Draft = { name: '', persona: '', samplesText: '', credentials: {} };

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
