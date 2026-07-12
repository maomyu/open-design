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
import { anyArticlePlatform, anyPublishingModule, anyShortVideoPlatform, hasFeature, useLicense } from '../state/license';

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
  | 'studio-zhihu'
  | 'studio-weibo'
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
  const license = useLicense();
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
        {/* 功能授权裁剪(2026-07-11):未授权的模块导航不渲染——客户看不到
            没买的能力。无授权文件时 hasFeature 恒真(全功能)。 */}
        {/* 「文章」入口(2026-07-10 用户拍板):公众号/知乎/微博同属文章形态,
            收进一个入口,内部平台切换(短视频/笔记是别的形态,各自独立)。 */}
        {anyArticlePlatform(license) ? (
          <NavButton
            active={view === 'studio' || view === 'studio-zhihu' || view === 'studio-weibo'}
            ariaLabel="文章"
            label="文章"
            onClick={() => onViewChange('studio')}
            testId="entry-nav-studio"
          >
            <Icon name="edit" size={18} />
          </NavButton>
        ) : null}
        {anyShortVideoPlatform(license) ? (
          <NavButton
            active={view === 'studio-video'}
            ariaLabel="短视频"
            label="短视频"
            onClick={() => onViewChange('studio-video')}
            testId="entry-nav-studio-video"
          >
            <Icon name="play" size={18} />
          </NavButton>
        ) : null}
        {hasFeature(license, 'note.xiaohongshu') ? (
          <NavButton
            active={view === 'studio-note'}
            ariaLabel="笔记"
            label="笔记"
            onClick={() => onViewChange('studio-note')}
            testId="entry-nav-studio-note"
          >
            <Icon name="image" size={18} />
          </NavButton>
        ) : null}
        {/* 知识库是公司级资产(2026-07-08 用户拍板):一级入口,一处维护、
            三个创作台的 AI 全部共用,不再藏在单个创作台里。 */}
        {hasFeature(license, 'cap.ai') ? (
          <NavButton
            active={view === 'knowledge'}
            ariaLabel="知识库"
            label="知识库"
            onClick={() => onViewChange('knowledge')}
            testId="entry-nav-knowledge"
          >
            <Icon name="layers-filled" size={18} />
          </NavButton>
        ) : null}
        {/* 账号 = 有任一发布模块才有意义(绑定发布账号用)。 */}
        {anyPublishingModule(license) ? (
          <NavButton
            active={view === 'accounts'}
            ariaLabel={t('entry.navAccounts')}
            label={t('entry.navAccounts')}
            onClick={() => onViewChange('accounts')}
            testId="entry-nav-accounts"
          >
            <Icon name="grid" size={18} />
          </NavButton>
        ) : null}
        {/* 自动化(tasks)、设计体系、插件、项目入口对客户定制版隐藏
            (2026-07-04/07-08/07-09 用户拍板"目前用不到"——三创作台已替代
            插件流水线,项目由 AI 任务自动管理)。路由仍保留 ——
            /automations、/design-systems、/plugins、/projects 直链可达;
            要恢复入口把 NavButton 加回来即可。 */}
        {hasFeature(license, 'integrations') ? (
          <NavButton
            active={view === 'integrations'}
            ariaLabel={t('entry.navIntegrations')}
            label={t('entry.navIntegrations')}
            onClick={() => onViewChange('integrations')}
            testId="entry-nav-integrations"
          >
            <Icon name="link" size={18} />
          </NavButton>
        ) : null}
      </div>
      {/* 「最近」项目列表已移除(2026-07-09 用户拍板"不需要了")——项目
          入口走导航「项目」页;要恢复参考 git 历史加回 recent 区块。 */}
    </nav>
  );
}
