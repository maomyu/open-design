// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand logo,
// followed by the primary destinations users expect to keep in reach:
// New project, home, projects, automations, design systems, plugins,
// and integrations. Footer controls are reserved for lower-frequency
// support affordances such as the help launcher.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.

import { useMemo, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { Project } from '../types';

// How many recent projects to surface in the rail's Recent list. The list
// scrolls, so this is just a soft cap to keep the DOM small.
const RECENT_LIMIT = 12;

export type EntryView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  /** Project history, surfaced as a scrollable "Recent" list in the rail. */
  projects: Project[];
  onOpenProject: (id: string) => void;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, label, onClick, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden="true">
        {children}
      </span>
      <span className="entry-nav-rail__label">{label}</span>
    </button>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  projects,
  onOpenProject,
}: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';
  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT),
    [projects],
  );

  return (
    <nav className="entry-nav-rail" aria-label="Primary">
      <div className="entry-nav-rail__group">
        <button
          type="button"
          className="entry-nav-rail__logo"
          onClick={() => onViewChange('home')}
          aria-label={brandLabel}
          data-testid="entry-nav-logo"
        >
          <img
            src="/app-icon.svg"
            alt=""
            className="entry-nav-rail__logo-img"
            draggable={false}
          />
          <span className="entry-nav-rail__wordmark">
            <span className="entry-nav-rail__wordmark-name">{brandLabel}</span>
            <span className="entry-nav-rail__wordmark-sub">{t('app.brandPill')}</span>
          </span>
        </button>
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />
        <NavButton
          ariaLabel={t('entry.navNewProject')}
          label={t('entry.navNewProject')}
          onClick={onNewProject}
          testId="entry-nav-new-project"
        >
          <Icon name="plus" size={18} />
        </NavButton>
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          label={homeLabel}
          onClick={() => onViewChange('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={18} />
        </NavButton>
        <NavButton
          active={view === 'projects'}
          ariaLabel={t('entry.navProjects')}
          label={t('entry.navProjects')}
          onClick={() => onViewChange('projects')}
          testId="entry-nav-projects"
        >
          <Icon name="folder" size={18} />
        </NavButton>
        <NavButton
          active={view === 'tasks'}
          ariaLabel={t('entry.navTasks')}
          label={t('entry.navTasks')}
          onClick={() => onViewChange('tasks')}
          testId="entry-nav-tasks"
        >
          <Icon name="kanban" size={18} />
        </NavButton>
        <NavButton
          active={view === 'plugins'}
          ariaLabel={t('entry.navPlugins')}
          label={t('entry.navPlugins')}
          onClick={() => onViewChange('plugins')}
          testId="entry-nav-plugins"
        >
          <Icon name="puzzle" size={18} />
        </NavButton>
        <NavButton
          active={view === 'design-systems'}
          ariaLabel={t('entry.navDesignSystems')}
          label={t('entry.navDesignSystems')}
          onClick={() => onViewChange('design-systems')}
          testId="entry-nav-design-systems"
        >
          <Icon name="blocks" size={18} />
        </NavButton>
        <NavButton
          active={view === 'integrations'}
          ariaLabel={t('entry.navIntegrations')}
          label={t('entry.navIntegrations')}
          onClick={() => onViewChange('integrations')}
          testId="entry-nav-integrations"
        >
          <Icon name="link" size={18} />
        </NavButton>
      </div>
      <div className="entry-nav-rail__recent" aria-label={t('entry.navRecent')}>
        <div className="entry-nav-rail__recent-label">{t('entry.navRecent')}</div>
        <div className="entry-nav-rail__recent-list">
          {recentProjects.length === 0 ? (
            <div className="entry-nav-rail__recent-empty">—</div>
          ) : (
            recentProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="entry-nav-rail__recent-item"
                onClick={() => onOpenProject(project.id)}
                title={project.name}
                data-testid={`entry-nav-recent-${project.id}`}
              >
                {project.name || t('entry.navProjects')}
              </button>
            ))
          )}
        </div>
      </div>
    </nav>
  );
}
