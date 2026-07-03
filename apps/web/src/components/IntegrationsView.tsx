import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppConfig } from '../types';
import { useAnalytics } from '../analytics/provider';
import {
  trackIntegrationsConnectorsTabClick,
  trackIntegrationsTabClick,
  trackPageView,
  trackSettingsConnectorAuthResult,
} from '../analytics/events';
import { ConnectorSection } from './SettingsDialog';
import { Icon } from './Icon';
import { McpClientSection } from './McpClientSection';
import { SkillsSection } from './SkillsSection';
import { ThirdPartyApiKeysSection } from './ThirdPartyApiKeysSection';
import { UseEverywhereGuidePanel } from './UseEverywhereModal';
import { useT } from '../i18n';

export type IntegrationTab = 'mcp' | 'connectors' | 'skills' | 'use-everywhere';

interface Props {
  config: AppConfig;
  initialTab?: IntegrationTab;
  composioConfigLoading?: boolean;
  onPersistComposioKey: (composio: AppConfig['composio']) => Promise<void> | void;
  // Persist a full config change. The Skills tab toggles `disabledSkills`
  // and needs each flip written through immediately — unlike the modal
  // Settings surface there is no "close to save" gesture on this page.
  onPersistConfig?: (cfg: AppConfig) => Promise<void> | void;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
}

const INTEGRATION_TABS: ReadonlyArray<{
  id: IntegrationTab;
}> = [
  { id: 'mcp' },
  { id: 'connectors' },
  { id: 'skills' },
  { id: 'use-everywhere' },
];

function integrationTabToTrackingElement(
  id: IntegrationTab,
): 'mcp' | 'connectors' | 'skills' | 'use_everywhere' {
  if (id === 'use-everywhere') return 'use_everywhere';
  return id;
}

export function IntegrationsView({
  config,
  initialTab = 'mcp',
  composioConfigLoading = false,
  onPersistComposioKey,
  onPersistConfig,
  onSkillsRefresh,
  onSkillsChanged,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const integrationsPageViewFiredRef = useRef(false);
  useEffect(() => {
    if (integrationsPageViewFiredRef.current) return;
    integrationsPageViewFiredRef.current = true;
    trackPageView(analytics.track, { page_name: 'integrations' });
  }, [analytics.track]);
  const [activeTab, setActiveTab] = useState<IntegrationTab>(initialTab);
  const [localConfig, setLocalConfig] = useState<AppConfig>(config);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setLocalConfig((curr) => ({
      ...curr,
      composio: config.composio,
    }));
  }, [config.composio]);

  // Keep the Skills toggle state in sync with the canonical config so an
  // external change (another surface, a daemon push) is reflected here.
  useEffect(() => {
    setLocalConfig((curr) => ({
      ...curr,
      disabledSkills: config.disabledSkills,
    }));
  }, [config.disabledSkills]);

  // SkillsSection mutates config via a standard React setter. Resolve the
  // update against local state for an instant UI flip, then persist the
  // resolved config so the disabled-skill preference survives a reload.
  const setSkillsCfg = useCallback<Dispatch<SetStateAction<AppConfig>>>(
    (action) => {
      setLocalConfig((curr) => {
        const next =
          typeof action === 'function'
            ? (action as (c: AppConfig) => AppConfig)(curr)
            : action;
        void onPersistConfig?.(next);
        return next;
      });
    },
    [onPersistConfig],
  );

  const liveDaemonUrl =
    typeof window !== 'undefined' ? window.location.origin : undefined;

  return (
    <section className="integrations-view" aria-labelledby="integrations-title">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('integrations.kicker')}</p>
          <h1 id="integrations-title" className="entry-section__title">
            {t('entry.navIntegrations')}
          </h1>
          <p className="integrations-view__lede">
            {t('integrations.lede')}
          </p>
        </div>
        <div className="integrations-view__badge" aria-hidden="true">
          <Icon name="link" size={15} />
          <span>{t('integrations.agentReady')}</span>
        </div>
      </header>

      <nav
        className="integrations-view__tabs"
        role="tablist"
        aria-label={t('integrations.areasAria')}
      >
        {INTEGRATION_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`integrations-view__tab${active ? ' is-active' : ''}`}
              onClick={() => {
                trackIntegrationsTabClick(analytics.track, {
                  page_name: 'integrations',
                  area: 'integrations_tab',
                  element: integrationTabToTrackingElement(tab.id),
                });
                setActiveTab(tab.id);
              }}
              data-testid={`integrations-tab-${tab.id}`}
            >
              <span className="integrations-view__tab-label">{integrationTabLabel(tab.id, t)}</span>
              <span className="integrations-view__tab-hint">{integrationTabHint(tab.id, t)}</span>
            </button>
          );
        })}
      </nav>

      <div className="integrations-view__panel">
        {activeTab === 'mcp' ? <McpClientSection /> : null}

        {activeTab === 'connectors' ? (
          <>
          <ConnectorSection
            cfg={localConfig}
            setCfg={setLocalConfig}
            composioConfigLoading={composioConfigLoading}
            onPersistComposioKey={onPersistComposioKey}
            onConnectorsTabClick={(element) =>
              trackIntegrationsConnectorsTabClick(analytics.track, {
                page_name: 'integrations',
                area: 'connectors_tab',
                element,
              })
            }
            onConnectorAuthResult={({ connectorId, action, result, errorCode }) =>
              trackSettingsConnectorAuthResult(analytics.track, {
                page_name: 'settings',
                area: 'connectors',
                connector_id: connectorId,
                action,
                result,
                ...(errorCode ? { error_code: errorCode } : {}),
              })
            }
          />
          {/* Global third-party service keys (e.g. TIKHUB_API_KEY). Stored
              in the daemon's app-config and injected into agent runs as
              env vars — see ThirdPartyApiKeysSection for details. */}
          <ThirdPartyApiKeysSection />
          </>
        ) : null}

        {activeTab === 'skills' ? (
          <SkillsSection
            cfg={localConfig}
            setCfg={setSkillsCfg}
            {...(onSkillsRefresh ? { onSkillsRefresh } : {})}
            {...(onSkillsChanged ? { onSkillsChanged } : {})}
          />
        ) : null}

        {activeTab === 'use-everywhere' ? (
          <div className="integrations-view__use-everywhere">
            <UseEverywhereGuidePanel
              onOpenSettings={() => setActiveTab('mcp')}
              {...(liveDaemonUrl ? { daemonUrl: liveDaemonUrl } : {})}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function integrationTabLabel(id: IntegrationTab, t: ReturnType<typeof useT>): string {
  switch (id) {
    case 'mcp': return t('integrations.tabLabel.mcp');
    case 'connectors': return t('entry.tabConnectors');
    case 'skills': return t('integrations.tabLabel.skills');
    case 'use-everywhere': return t('entry.useEverywhereTitle');
  }
}

function integrationTabHint(id: IntegrationTab, t: ReturnType<typeof useT>): string {
  switch (id) {
    case 'mcp': return t('integrations.tabHint.mcp');
    case 'connectors': return t('integrations.tabHint.connectors');
    case 'skills': return t('settings.skillsHint');
    case 'use-everywhere': return t('integrations.tabHint.useEverywhere');
  }
}
