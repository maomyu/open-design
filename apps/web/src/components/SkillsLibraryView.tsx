// Skill library — the inventory half of the orchestration story. Lists every
// skill the daemon discovers (built-in catalog + user-created), shows where
// each came from and WHICH PLUGINS USE IT (global context refs + stage-level
// bindings via GET /api/skills/usage), and offers create/delete. The create
// flow is the same AI-draft studio plugins use; deep edits stay file-based.

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { Icon } from './Icon';
import { Toast } from './Toast';
import './SkillsLibraryView.css';

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'claude' | 'built-in';
  category: string | null;
}

export function SkillsLibraryView() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [usage, setUsage] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  async function refresh() {
    const [skillsResp, usageResp] = await Promise.all([
      fetch('/api/skills').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/skills/usage').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const rows = ((skillsResp?.skills ?? []) as Array<Record<string, unknown>>)
      // Derived `<parent>:<child>` example cards are gallery sugar, not
      // library entries.
      .filter((s) => typeof s.id === 'string' && !(s.id as string).includes(':'))
      .map((s) => ({
        id: s.id as string,
        name: (s.name as string) || (s.id as string),
        description: typeof s.description === 'string' ? s.description : '',
        source:
          s.source === 'user'
            ? ('user' as const)
            : s.source === 'claude'
              ? ('claude' as const)
              : ('built-in' as const),
        category: typeof s.category === 'string' ? s.category : null,
      }));
    setSkills(rows);
    setUsage((usageResp?.usage ?? {}) as Record<string, string[]>);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? skills.filter(
          (s) =>
            s.id.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
      : skills;
    // User skills first (they're the operator's own work), then by id.
    return [...base].sort((a, b) =>
      a.source === b.source ? a.id.localeCompare(b.id) : a.source === 'user' ? -1 : 1,
    );
  }, [skills, query]);

  async function remove(id: string) {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
      () => null,
    );
    if (resp?.ok) {
      setToast(t('skillsLibrary.deleted'));
      void refresh();
    } else {
      setToast(t('creator.saveFailed'));
    }
  }

  function onBack() {
    if (window.history.length > 1) window.history.back();
    else navigate({ kind: 'home', view: 'plugins' });
  }

  return (
    <div className="skills-library" data-testid="skills-library">
      <header className="skills-library__bar">
        <button type="button" className="skills-library__back" onClick={onBack}>
          <Icon name="arrow-left" size={15} />
          <span>{t('pluginEditor.back')}</span>
        </button>
        <div className="skills-library__heading">
          <span className="skills-library__eyebrow">{t('creator.eyebrow')}</span>
          <h1 className="skills-library__title">{t('skillsLibrary.title')}</h1>
        </div>
        <button
          type="button"
          className="skills-library__create"
          onClick={() => navigate({ kind: 'creator', target: 'skill' })}
          data-testid="skills-library-create"
        >
          <Icon name="sparkles" size={13} />
          <span>{t('creator.skillTitle')}</span>
        </button>
      </header>

      <div className="skills-library__body">
        <p className="skills-library__lede">{t('skillsLibrary.lede')}</p>
        <input
          className="skills-library__search"
          value={query}
          placeholder={t('skillsLibrary.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading ? (
          <div className="skills-library__loading">{t('common.loading')}</div>
        ) : (
          <div className="skills-library__list">
            {filtered.map((skill) => {
              const usedBy = usage[skill.id] ?? [];
              return (
                <div className="skills-library__row" key={skill.id}>
                  <div className="skills-library__row-main">
                    <div className="skills-library__row-head">
                      <span className="skills-library__name">{skill.name}</span>
                      <span
                        className={`skills-library__pill skills-library__pill--${skill.source}`}
                      >
                        {skill.source === 'user'
                          ? t('skillsLibrary.sourceUser')
                          : skill.source === 'claude'
                            ? t('skillsLibrary.sourceClaude')
                            : t('skillsLibrary.sourceBuiltIn')}
                      </span>
                      {skill.category ? (
                        <span className="skills-library__pill">{skill.category}</span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="skills-library__desc">{skill.description}</p>
                    ) : null}
                    {usedBy.length > 0 ? (
                      <div className="skills-library__used-by">
                        <span className="skills-library__used-label">
                          {t('skillsLibrary.usedBy')}
                        </span>
                        {usedBy.map((pluginId) => (
                          <button
                            key={pluginId}
                            type="button"
                            className="skills-library__plugin-link"
                            onClick={() =>
                              navigate({ kind: 'marketplace-edit', pluginId })
                            }
                          >
                            {pluginId}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {skill.source === 'user' ? (
                    <button
                      type="button"
                      className="skills-library__delete"
                      onClick={() => remove(skill.id)}
                      aria-label={t('skillsLibrary.delete')}
                      title={t('skillsLibrary.delete')}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {filtered.length === 0 ? (
              <div className="skills-library__empty">{t('skillsLibrary.empty')}</div>
            ) : null}
          </div>
        )}
      </div>
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
