// Account-profiles editor — a plugin that declares `od.accounts` (e.g. 公众号
// 发布) drives several named accounts, each with its OWN credentials AND its own
// writing persona. The operator manages them here; at runtime the workflow's
// first step picks one and that account's persona drives the writing step.
// Credential VALUES are never returned by the daemon (only presence flags), so
// secret inputs start empty and blank = keep.

import { useEffect, useState } from 'react';
import type { AccountProfileView, PluginConfigKeyView } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { Toast } from './Toast';
import {
  fetchPluginAccounts,
  fetchPluginConfig,
  savePluginAccount,
  deletePluginAccount,
} from '../providers/daemon';

interface Props {
  pluginId: string;
  editable: boolean;
}

// Human-facing metadata for one credential key. The plugin already declares
// label/description/secret/link for every key in `od.config` — the account
// form reuses that instead of showing raw env-var names like WECHAT_APPID.
interface CredKeyMeta {
  label: string;
  description?: string;
  secret: boolean;
  link?: string;
}

function credMetaFromConfig(keys: PluginConfigKeyView[]): Record<string, CredKeyMeta> {
  const out: Record<string, CredKeyMeta> = {};
  for (const k of keys) {
    out[k.name] = {
      label: k.label ?? k.name,
      ...(k.description ? { description: k.description } : {}),
      secret: k.secret,
      ...(k.link ? { link: k.link } : {}),
    };
  }
  return out;
}

// A blank draft the add/edit form binds to. `samples` is edited as one textarea
// (blank-line separated) and split on save.
interface Draft {
  id?: string;
  name: string;
  persona: string;
  samplesText: string;
  credentials: Record<string, string>;
}

const EMPTY_DRAFT: Draft = { name: '', persona: '', samplesText: '', credentials: {} };

export function PluginAccountsSection({ pluginId, editable }: Props) {
  const { t } = useI18n();
  const [credentialKeys, setCredentialKeys] = useState<string[]>([]);
  const [credMeta, setCredMeta] = useState<Record<string, CredKeyMeta>>({});
  const [accounts, setAccounts] = useState<AccountProfileView[]>([]);
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // Save feedback — a rejected save (duplicate name, daemon down) must SAY so
  // inline; success flashes a toast. A silent no-op reads as "没保存上".
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function refresh() {
    const data = await fetchPluginAccounts(pluginId);
    if (!data) return;
    setCredentialKeys(data.credentialKeys);
    setAccounts(data.accounts);
    // The plugin supports accounts iff it declares credential keys OR the daemon
    // returned an (empty) accounts array with the feature enabled.
    setSupported(data.credentialKeys.length > 0 || data.accounts.length > 0);
    // First-run nudge: the section starts EXPANDED while no account exists yet,
    // so the setup entry point is discoverable instead of hidden behind a
    // collapsed header. Once accounts exist it behaves like the config panel.
    if (data.accounts.length === 0 && (data.credentialKeys.length > 0)) setOpen(true);
  }

  useEffect(() => {
    void refresh();
    // Credential labels/descriptions come from the plugin's od.config
    // declarations — the same metadata the 插件配置 panel shows — so the
    // account form can say 「公众号 AppID」 instead of WECHAT_APPID.
    void fetchPluginConfig(pluginId).then((cfg) => {
      if (cfg) setCredMeta(credMetaFromConfig(cfg.keys));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);

  if (!supported) return null;

  function beginAdd() {
    setSaveError(null);
    setDraft({ ...EMPTY_DRAFT, credentials: {} });
    setOpen(true);
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
    setOpen(true);
  }

  async function save() {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true);
    const samples = draft.samplesText
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Only send credential inputs the operator actually typed (blank = keep).
    const credentials: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.credentials)) {
      if (typeof v === 'string' && v.trim()) credentials[k] = v.trim();
    }
    setSaveError(null);
    const result = await savePluginAccount(pluginId, {
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
    setToast(t('pluginEditor.accountSaved'));
    await refresh();
  }

  async function remove(id: string) {
    if (!editable) return;
    const ok = await deletePluginAccount(pluginId, id);
    if (ok) await refresh();
  }

  return (
    <section className="plugin-edit-view__config" data-testid="plugin-edit-accounts">
      <button
        type="button"
        className="plugin-edit-view__config-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="grid" size={13} />
        <span>{t('pluginEditor.accountsHeading')}</span>
        <span className="plugin-edit-view__config-count">{accounts.length}</span>
        <span
          className={`plugin-edit-view__config-chevron${open ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {open ? (
        <div className="plugin-edit-view__config-body">
          <p className="plugin-edit-view__config-hint">{t('pluginEditor.accountsHint')}</p>

          <div className="plugin-edit-view__accounts-list">
            {accounts.length === 0 ? (
              <div className="plugin-edit-view__accounts-empty">{t('pluginEditor.accountEmpty')}</div>
            ) : (
              accounts.map((a) => (
                <div className="plugin-edit-view__account-card" key={a.id} data-testid={`plugin-account-${a.id}`}>
                  <div className="plugin-edit-view__account-head">
                    <span className="plugin-edit-view__account-name">{a.name}</span>
                    <code className="plugin-edit-view__account-id">{a.id}</code>
                    <div className="plugin-edit-view__account-actions">
                      <button
                        type="button"
                        className="plugin-edit-view__step-link"
                        onClick={() => beginEdit(a)}
                        disabled={!editable}
                      >
                        <Icon name="edit" size={12} />
                        <span>{t('pluginEditor.accountEdit')}</span>
                      </button>
                      <button
                        type="button"
                        className="plugin-edit-view__step-link plugin-edit-view__step-link--danger"
                        onClick={() => void remove(a.id)}
                        disabled={!editable}
                      >
                        <Icon name="trash" size={12} />
                        <span>{t('pluginEditor.accountDelete')}</span>
                      </button>
                    </div>
                  </div>
                  {a.style?.persona ? (
                    <p className="plugin-edit-view__account-persona">{a.style.persona}</p>
                  ) : null}
                  <div className="plugin-edit-view__account-creds">
                    {credentialKeys.map((k) => (
                      <span
                        key={k}
                        title={k}
                        className={`plugin-edit-view__account-cred${a.credentials[k] ? ' is-set' : ''}`}
                      >
                        {credMeta[k]?.label ?? k}
                        {a.credentials[k] ? ` · ${t('pluginEditor.configSet')}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {draft ? (
            <div className="plugin-edit-view__account-form" data-testid="plugin-account-form">
              <label className="plugin-edit-view__account-field">
                <span>{t('pluginEditor.accountName')}</span>
                <input
                  className="plugin-edit-view__account-input"
                  value={draft.name}
                  disabled={!editable || saving}
                  placeholder={t('pluginEditor.accountNamePlaceholder')}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="plugin-edit-view__account-field">
                <span>{t('pluginEditor.accountPersona')}</span>
                <textarea
                  className="plugin-edit-view__account-textarea"
                  value={draft.persona}
                  disabled={!editable || saving}
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
                  disabled={!editable || saving}
                  spellCheck={false}
                  placeholder={t('pluginEditor.accountSamplesHint')}
                  onChange={(e) => setDraft({ ...draft, samplesText: e.target.value })}
                />
              </label>
              {credentialKeys.length > 0 ? (
                <div className="plugin-edit-view__account-cred-inputs">
                  <span className="plugin-edit-view__account-field-label">
                    {t('pluginEditor.accountCredentials')}
                  </span>
                  <span className="plugin-edit-view__account-cred-hint">
                    {t('pluginEditor.accountCredsHint')}
                  </span>
                  {credentialKeys.map((k) => {
                    const meta = credMeta[k] ?? { label: k, secret: true };
                    const isSet = Boolean(accounts.find((a) => a.id === draft.id)?.credentials[k]);
                    return (
                      <label className="plugin-edit-view__account-field" key={k}>
                        <span>
                          {meta.label}
                          {meta.label !== k ? (
                            <code className="plugin-edit-view__account-cred-key">{k}</code>
                          ) : null}
                        </span>
                        {meta.description ? (
                          <span className="plugin-edit-view__account-cred-desc">
                            {meta.description}
                            {meta.link ? (
                              <a href={meta.link} target="_blank" rel="noopener noreferrer"> ↗</a>
                            ) : null}
                          </span>
                        ) : null}
                        <input
                          type={meta.secret ? 'password' : 'text'}
                          className="plugin-edit-view__account-input"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={!editable || saving}
                          placeholder={isSet ? '••••••  ·  ' + t('pluginEditor.configSet') : ''}
                          value={draft.credentials[k] ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, credentials: { ...draft.credentials, [k]: e.target.value } })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {saveError ? (
                <div className="plugin-edit-view__account-error" role="alert" data-testid="plugin-account-save-error">
                  {t('pluginEditor.accountSaveFailed')}: {saveError}
                </div>
              ) : null}
              <div className="plugin-edit-view__account-form-foot">
                <button
                  type="button"
                  className="plugin-edit-view__config-save"
                  disabled={!editable || saving || !draft.name.trim()}
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
          ) : editable ? (
            <button type="button" className="plugin-edit-view__config-save" onClick={beginAdd}>
              <Icon name="plus" size={12} />
              <span>{t('pluginEditor.accountAdd')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </section>
  );
}
