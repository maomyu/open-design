// Direct plugin editor. The plugin IS the asset — its prompts are files
// (SKILL.md body + the kickoff query). Edit them here and "保存并发布":
// the daemon writes them back and re-registers the plugin so the next run
// uses the new prompts. Transparent, portable, version-controllable — no
// hidden preference layer.

import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { Toast } from './Toast';
import { fetchPluginSource, savePluginSource } from '../providers/daemon';
import './PluginEditor.css';

interface Props {
  pluginId: string;
  pluginTitle?: string;
  onClose: () => void;
}

export function PluginEditor({ pluginId, pluginTitle, onClose }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [editable, setEditable] = useState(true);
  const [skill, setSkill] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPluginSource(pluginId).then((src) => {
      if (cancelled) return;
      if (src) {
        setSkill(src.skill);
        setQuery(src.query);
        setEditable(src.editable);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  async function save() {
    if (saving || !editable) return;
    setSaving(true);
    const ok = await savePluginSource(pluginId, { skill, query });
    setSaving(false);
    if (ok) {
      setDirty(false);
      setToast(t('pluginEditor.published'));
    } else {
      setToast(t('pluginEditor.failed'));
    }
  }

  return (
    <div className="plugin-editor__backdrop" role="presentation" onClick={onClose}>
      <div
        className="plugin-editor"
        role="dialog"
        aria-modal="true"
        aria-label={t('pluginEditor.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="plugin-editor__head">
          <div>
            <div className="plugin-editor__eyebrow">{t('pluginEditor.title')}</div>
            <h2 className="plugin-editor__name">{pluginTitle ?? pluginId}</h2>
          </div>
          <button
            type="button"
            className="plugin-editor__close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {loading ? (
          <div className="plugin-editor__loading">{t('common.loading')}</div>
        ) : (
          <div className="plugin-editor__body">
            {!editable ? (
              <div className="plugin-editor__readonly">{t('pluginEditor.readOnly')}</div>
            ) : null}

            <label className="plugin-editor__field">
              <span className="plugin-editor__label">{t('pluginEditor.queryLabel')}</span>
              <span className="plugin-editor__hint">{t('pluginEditor.queryHint')}</span>
              <textarea
                className="plugin-editor__textarea plugin-editor__textarea--query"
                value={query}
                disabled={!editable}
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setDirty(true);
                }}
              />
            </label>

            <label className="plugin-editor__field">
              <span className="plugin-editor__label">{t('pluginEditor.skillLabel')}</span>
              <span className="plugin-editor__hint">{t('pluginEditor.skillHint')}</span>
              <textarea
                className="plugin-editor__textarea plugin-editor__textarea--skill"
                value={skill}
                disabled={!editable}
                spellCheck={false}
                onChange={(e) => {
                  setSkill(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
          </div>
        )}

        <footer className="plugin-editor__foot">
          <span className="plugin-editor__foot-note">
            {dirty ? t('pluginEditor.unsaved') : ''}
          </span>
          <div className="plugin-editor__foot-actions">
            <button type="button" className="plugin-editor__btn" onClick={onClose}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="plugin-editor__btn plugin-editor__btn--primary"
              onClick={save}
              disabled={saving || !editable || loading}
            >
              {saving ? t('pluginEditor.publishing') : t('pluginEditor.publish')}
            </button>
          </div>
        </footer>
      </div>
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
