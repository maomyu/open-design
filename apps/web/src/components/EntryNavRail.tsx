// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand logo,
// followed by the primary destinations users expect to keep in reach:
// New project, home, projects, automations, design systems, plugins,
// and integrations. Footer controls are reserved for lower-frequency
// support affordances such as the help launcher.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.

import { type ReactNode } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';

export type EntryView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'accounts'
  | 'studio'
  | 'studio-video'
  | 'studio-note'
  | 'knowledge'
  | 'design-systems'
  | 'integrations';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
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

export function EntryNavRail({ view, onViewChange }: Props) {
  const t = useT();
  const brandLabel = t('app.brand');

  return (
    <nav className="entry-nav-rail" aria-label="Primary">
      <div className="entry-nav-rail__group">
        <button
          type="button"
          className="entry-nav-rail__logo"
          onClick={() => onViewChange('studio')}
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
            {/* 「研究预览版」副标已移除(2026-07-09 用户拍板)。 */}
          </span>
        </button>
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />
        {/* 「新建项目」与「主页」入口对客户定制版隐藏(2026-07-04 与 2026-07-08
            用户拍板)——动线全部从创作台开工,项目由运行自动创建;主页 /home
            直链仍可达,要恢复把 NavButton 加回、logo onClick 改回 'home'。 */}
        {/* 创作台（客户定制,中文文案不进 i18n;spec: specs/current/media-studio.md） */}
        <NavButton
          active={view === 'studio'}
          ariaLabel="公众号"
          label="公众号"
          onClick={() => onViewChange('studio')}
          testId="entry-nav-studio"
        >
          <Icon name="edit" size={18} />
        </NavButton>
        <NavButton
          active={view === 'studio-video'}
          ariaLabel="短视频"
          label="短视频"
          onClick={() => onViewChange('studio-video')}
          testId="entry-nav-studio-video"
        >
          <Icon name="play" size={18} />
        </NavButton>
        <NavButton
          active={view === 'studio-note'}
          ariaLabel="笔记"
          label="笔记"
          onClick={() => onViewChange('studio-note')}
          testId="entry-nav-studio-note"
        >
          <Icon name="image" size={18} />
        </NavButton>
        {/* 知识库是公司级资产(2026-07-08 用户拍板):一级入口,一处维护、
            三个创作台的 AI 全部共用,不再藏在单个创作台里。 */}
        <NavButton
          active={view === 'knowledge'}
          ariaLabel="知识库"
          label="知识库"
          onClick={() => onViewChange('knowledge')}
          testId="entry-nav-knowledge"
        >
          <Icon name="layers-filled" size={18} />
        </NavButton>
        <NavButton
          active={view === 'accounts'}
          ariaLabel={t('entry.navAccounts')}
          label={t('entry.navAccounts')}
          onClick={() => onViewChange('accounts')}
          testId="entry-nav-accounts"
        >
          <Icon name="grid" size={18} />
        </NavButton>
        {/* 自动化(tasks)、设计体系、插件、项目入口对客户定制版隐藏
            (2026-07-04/07-08/07-09 用户拍板"目前用不到"——三创作台已替代
            插件流水线,项目由 AI 任务自动管理)。路由仍保留 ——
            /automations、/design-systems、/plugins、/projects 直链可达;
            要恢复入口把 NavButton 加回来即可。 */}
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
      {/* 「最近」项目列表已移除(2026-07-09 用户拍板"不需要了")——项目
          入口走导航「项目」页;要恢复参考 git 历史加回 recent 区块。 */}
    </nav>
  );
}
