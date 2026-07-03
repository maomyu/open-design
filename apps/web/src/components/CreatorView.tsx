// AI-draft creation studio — the UI half of POST /api/plugins/draft and
// POST /api/skills/draft. Two phases:
//
//   1. Describe — the operator writes what the plugin/skill should do in
//      natural language (the richer the description, the better the draft).
//   2. Review — the draft comes back WITH spec diagnostics; the operator
//      hand-tunes the fields and saves. Nothing touches disk until save.
//
// Saving a plugin registers it as an editable user plugin and jumps straight
// into the full plugin editor for deeper iteration; saving a skill lands it
// in the user skill library. The deep-edit surface stays in PluginEditView —
// this view deliberately keeps review lightweight instead of duplicating the
// stage/mode editor.

import { useState } from 'react';
import type {
  CreatePluginDraftResponse,
  CreateSkillDraftResponse,
  PluginDraftDiagnostic,
  SkillDraftDiagnostic,
} from '@open-design/contracts';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { Icon } from './Icon';
import { Toast } from './Toast';
import { draftPlugin, draftSkill, savePluginDraft, saveSkillDraft } from '../providers/daemon';
import './CreatorView.css';

interface Props {
  target: 'plugin' | 'skill';
}

type AnyDiagnostic = PluginDraftDiagnostic | SkillDraftDiagnostic;

export function CreatorView({ target }: Props) {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [pluginDraft, setPluginDraft] = useState<CreatePluginDraftResponse | null>(null);
  const [skillDraft, setSkillDraft] = useState<CreateSkillDraftResponse | null>(null);
  const draft = target === 'plugin' ? pluginDraft : skillDraft;
  const diagnostics: AnyDiagnostic[] = draft?.diagnostics ?? [];
  const hasErrors = diagnostics.some((d) => d.severity === 'error');

  function onBack() {
    if (window.history.length > 1) window.history.back();
    else navigate({ kind: 'home', view: 'plugins' });
  }

  async function runDraft() {
    const text = description.trim();
    if (drafting || !text) return;
    setDrafting(true);
    setError(null);
    if (target === 'plugin') {
      const out = await draftPlugin({ description: text });
      if ('error' in out) setError(out.error || t('creator.draftFailed'));
      else setPluginDraft(out);
    } else {
      const out = await draftSkill({ description: text });
      if ('error' in out) setError(out.error || t('creator.draftFailed'));
      else setSkillDraft(out);
    }
    setDrafting(false);
  }

  async function save() {
    if (saving || !draft || hasErrors) return;
    setSaving(true);
    setError(null);
    if (target === 'plugin' && pluginDraft) {
      const out = await savePluginDraft({
        name: pluginDraft.name,
        title: pluginDraft.title,
        description: pluginDraft.description,
        query: pluginDraft.query,
        skill: pluginDraft.skill,
        stages: pluginDraft.stages,
      });
      setSaving(false);
      if ('error' in out) {
        setError(out.error || t('creator.saveFailed'));
        return;
      }
      // Land in the full editor so deeper iteration starts immediately.
      navigate({ kind: 'marketplace-edit', pluginId: out.id });
      return;
    }
    if (target === 'skill' && skillDraft) {
      const out = await saveSkillDraft(skillDraft);
      setSaving(false);
      if ('error' in out) {
        setError(out.error || t('creator.saveFailed'));
        return;
      }
      setToast(t('creator.skillSaved'));
      window.setTimeout(() => navigate({ kind: 'home', view: 'plugins' }), 1200);
    }
  }

  const heading = target === 'plugin' ? t('creator.pluginTitle') : t('creator.skillTitle');
  const lede = target === 'plugin' ? t('creator.pluginLede') : t('creator.skillLede');
  const placeholder =
    target === 'plugin' ? t('creator.pluginPlaceholder') : t('creator.skillPlaceholder');

  return (
    <div className="creator-view" data-testid="creator-view">
      <header className="creator-view__bar">
        <button type="button" className="creator-view__back" onClick={onBack}>
          <Icon name="arrow-left" size={15} />
          <span>{t('pluginEditor.back')}</span>
        </button>
        <div className="creator-view__heading">
          <span className="creator-view__eyebrow">{t('creator.eyebrow')}</span>
          <h1 className="creator-view__title">{heading}</h1>
        </div>
        <div className="creator-view__switch" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={target === 'plugin'}
            className={`creator-view__switch-btn${target === 'plugin' ? ' creator-view__switch-btn--on' : ''}`}
            onClick={() => navigate({ kind: 'creator', target: 'plugin' })}
          >
            {t('creator.targetPlugin')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={target === 'skill'}
            className={`creator-view__switch-btn${target === 'skill' ? ' creator-view__switch-btn--on' : ''}`}
            onClick={() => navigate({ kind: 'creator', target: 'skill' })}
          >
            {t('creator.targetSkill')}
          </button>
        </div>
        <div className="creator-view__bar-actions">
          {draft ? (
            <button
              type="button"
              className="creator-view__save"
              onClick={save}
              disabled={saving || hasErrors}
              data-testid="creator-save"
            >
              {saving ? t('creator.saving') : t('creator.save')}
            </button>
          ) : null}
        </div>
      </header>

      <div className="creator-view__body">
        <section className="creator-view__describe">
          <p className="creator-view__lede">{lede}</p>
          <textarea
            className="creator-view__description"
            value={description}
            placeholder={placeholder}
            disabled={drafting}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="creator-description"
          />
          <div className="creator-view__describe-actions">
            <button
              type="button"
              className="creator-view__draft-btn"
              onClick={runDraft}
              disabled={drafting || !description.trim()}
              data-testid="creator-draft"
            >
              <Icon name={drafting ? 'spinner' : 'sparkles'} size={14} />
              <span>
                {drafting
                  ? t('creator.drafting')
                  : draft
                    ? t('creator.redraft')
                    : t('creator.draftButton')}
              </span>
            </button>
          </div>
          {error ? <div className="creator-view__error">{error}</div> : null}
        </section>

        {draft ? (
          <section className="creator-view__review">
            {diagnostics.length > 0 ? (
              <div className="creator-view__diagnostics">
                {diagnostics.map((d, i) => (
                  <div
                    key={i}
                    className={`creator-view__diag creator-view__diag--${d.severity}`}
                  >
                    <Icon name={d.severity === 'error' ? 'close' : 'info'} size={12} />
                    <span>{d.message}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="creator-view__grid">
              <label className="creator-view__field creator-view__field--half">
                <span className="creator-view__label">{t('creator.nameLabel')}</span>
                <input
                  className="creator-view__input"
                  value={draft.name}
                  spellCheck={false}
                  onChange={(e) => {
                    const name = e.target.value;
                    if (target === 'plugin') setPluginDraft((p) => (p ? { ...p, name } : p));
                    else setSkillDraft((s) => (s ? { ...s, name } : s));
                  }}
                />
              </label>
              {target === 'plugin' && pluginDraft ? (
                <label className="creator-view__field creator-view__field--half">
                  <span className="creator-view__label">{t('creator.titleLabel')}</span>
                  <input
                    className="creator-view__input"
                    value={pluginDraft.title}
                    onChange={(e) =>
                      setPluginDraft((p) => (p ? { ...p, title: e.target.value } : p))
                    }
                  />
                </label>
              ) : null}
            </div>

            <label className="creator-view__field">
              <span className="creator-view__label">{t('creator.descriptionLabel')}</span>
              <textarea
                className="creator-view__textarea creator-view__textarea--short"
                value={draft.description}
                onChange={(e) => {
                  const v = e.target.value;
                  if (target === 'plugin') setPluginDraft((p) => (p ? { ...p, description: v } : p));
                  else setSkillDraft((s) => (s ? { ...s, description: v } : s));
                }}
              />
            </label>

            {target === 'plugin' && pluginDraft ? (
              <>
                <label className="creator-view__field">
                  <span className="creator-view__label">{t('pluginEditor.queryLabel')}</span>
                  <textarea
                    className="creator-view__textarea creator-view__textarea--short"
                    value={pluginDraft.query}
                    spellCheck={false}
                    onChange={(e) =>
                      setPluginDraft((p) => (p ? { ...p, query: e.target.value } : p))
                    }
                  />
                </label>
                <div className="creator-view__field">
                  <span className="creator-view__label">{t('pluginEditor.stepsLabel')}</span>
                  <span className="creator-view__hint">{t('creator.stagesHint')}</span>
                  <div className="creator-view__stages">
                    {pluginDraft.stages.map((s, i) => (
                      <div className="creator-view__stage" key={i}>
                        <div className="creator-view__stage-head">
                          <span className="creator-view__stage-num">{i + 1}</span>
                          <span className="creator-view__stage-title">{s.title || s.id}</span>
                          <span className={`creator-view__stage-gate creator-view__stage-gate--${s.gate}`}>
                            {t(`pluginEditor.gate${s.gate.charAt(0).toUpperCase()}${s.gate.slice(1)}` as
                              | 'pluginEditor.gateConfirm'
                              | 'pluginEditor.gateChoice'
                              | 'pluginEditor.gateNone')}
                          </span>
                        </div>
                        <p className="creator-view__stage-prompt">{s.prompt}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <label className="creator-view__field">
                  <span className="creator-view__label">{t('pluginEditor.skillLabel')}</span>
                  <textarea
                    className="creator-view__textarea creator-view__textarea--body"
                    value={pluginDraft.skill}
                    spellCheck={false}
                    onChange={(e) =>
                      setPluginDraft((p) => (p ? { ...p, skill: e.target.value } : p))
                    }
                  />
                </label>
              </>
            ) : null}

            {target === 'skill' && skillDraft ? (
              <>
                <label className="creator-view__field">
                  <span className="creator-view__label">{t('creator.triggersLabel')}</span>
                  <input
                    className="creator-view__input"
                    value={skillDraft.triggers.join(', ')}
                    spellCheck={false}
                    onChange={(e) =>
                      setSkillDraft((s) =>
                        s
                          ? {
                              ...s,
                              triggers: e.target.value
                                .split(/[,，]/)
                                .map((x) => x.trim())
                                .filter(Boolean),
                            }
                          : s,
                      )
                    }
                  />
                </label>
                <label className="creator-view__field">
                  <span className="creator-view__label">{t('creator.bodyLabel')}</span>
                  <textarea
                    className="creator-view__textarea creator-view__textarea--body"
                    value={skillDraft.body}
                    spellCheck={false}
                    onChange={(e) =>
                      setSkillDraft((s) => (s ? { ...s, body: e.target.value } : s))
                    }
                  />
                </label>
                {skillDraft.evals.length > 0 ? (
                  <div className="creator-view__field">
                    <span className="creator-view__label">{t('creator.evalsLabel')}</span>
                    <span className="creator-view__hint">{t('creator.evalsHint')}</span>
                    <ol className="creator-view__evals">
                      {skillDraft.evals.map((e) => (
                        <li key={e.id}>
                          <span className="creator-view__eval-prompt">{e.prompt}</span>
                          {e.expectedOutput ? (
                            <span className="creator-view__eval-expected">{e.expectedOutput}</span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
