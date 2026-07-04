// 自媒体 hub — one entry per platform (独立导航「自媒体」).
//
// The client-facing front door for self-media work: a fixed row of platform
// entries (公众号/抖音/小红书/快手/B站/视频号 — each a bundled plugin with a
// guided three-step flow) plus the cross-platform matrix (短视频工作流).
// Clicking an entry activates the plugin exactly like the plugins page's
// "Use" — composer fills with the guided brief, account dropdown included.

import { useEffect, useState } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { MEDIA_PLATFORMS } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { navigate } from '../router';
import { listPlugins } from '../state/projects';
import type { PluginUseAction } from './plugins-home/useActions';
import './MediaHubView.css';
import './PluginEditView.css';

// Fixed entry order: platform id → its bundled entry plugin.
const PLATFORM_ENTRY_PLUGINS: Array<{ platformId: string; pluginId: string }> = [
  { platformId: 'wechat-mp', pluginId: 'wechat-mp-publish' },
  { platformId: 'douyin', pluginId: 'douyin-publish' },
  { platformId: 'xiaohongshu', pluginId: 'xiaohongshu-publish' },
  { platformId: 'kuaishou', pluginId: 'kuaishou-publish' },
  { platformId: 'bilibili', pluginId: 'bilibili-publish' },
  { platformId: 'shipinhao', pluginId: 'shipinhao-publish' },
];

const MATRIX_PLUGIN_ID = 'short-video-copy';

interface Props {
  onUsePlugin?: (record: InstalledPluginRecord, action: PluginUseAction) => void;
}

export function MediaHubView({ onUsePlugin }: Props) {
  const { t, locale } = useI18n();
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void listPlugins().then((rows) => {
      if (cancelled) return;
      setPlugins(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function byId(id: string): InstalledPluginRecord | null {
    return plugins.find((p) => p.id === id) ?? null;
  }

  function platformTitle(platformId: string): string {
    return MEDIA_PLATFORMS.find((p) => p.id === platformId)?.title ?? platformId;
  }

  function use(record: InstalledPluginRecord) {
    onUsePlugin?.(record, 'use');
  }

  const matrix = byId(MATRIX_PLUGIN_ID);

  return (
    <section className="media-hub" aria-labelledby="media-hub-title">
      <header className="media-hub__hero">
        <div>
          <p className="plugins-view__kicker">{t('entry.navMedia')}</p>
          <h1 id="media-hub-title" className="entry-section__title">
            {t('mediaHub.title')}
          </h1>
          <p className="plugins-view__lede">{t('mediaHub.lede')}</p>
        </div>
        <button
          type="button"
          className="plugins-view__secondary"
          onClick={() => navigate({ kind: 'home', view: 'accounts' })}
          data-testid="media-hub-manage-accounts"
        >
          <Icon name="grid" size={13} />
          <span>{t('mediaHub.manageAccounts')}</span>
        </button>
      </header>

      {loading ? (
        <div className="plugins-view__empty">{t('pluginsView.loading')}</div>
      ) : (
        <>
          <div className="media-hub__grid" role="list">
            {PLATFORM_ENTRY_PLUGINS.map(({ platformId, pluginId }) => {
              const record = byId(pluginId);
              const title = platformTitle(platformId);
              return (
                <article
                  key={platformId}
                  role="listitem"
                  className={`media-hub__card${record ? '' : ' is-missing'}`}
                  data-testid={`media-hub-${platformId}`}
                >
                  <span className="media-hub__badge" aria-hidden>
                    {title.slice(0, 1)}
                  </span>
                  <div className="media-hub__card-body">
                    <h2>{title}{t('mediaHub.publishSuffix')}</h2>
                    <p>
                      {record
                        ? localizeDescription(record, locale)
                        : t('mediaHub.entryMissing')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="plugins-view__primary"
                    disabled={!record}
                    onClick={() => record && use(record)}
                    data-testid={`media-hub-use-${platformId}`}
                  >
                    {t('mediaHub.start')}
                  </button>
                </article>
              );
            })}
          </div>

          <div className="media-hub__matrix">
            <h2 className="media-hub__section-title">{t('mediaHub.matrixTitle')}</h2>
            <article className={`media-hub__card media-hub__card--matrix${matrix ? '' : ' is-missing'}`}>
              <span className="media-hub__badge media-hub__badge--matrix" aria-hidden>
                <Icon name="share" size={16} />
              </span>
              <div className="media-hub__card-body">
                <h2>{matrix?.title ?? t('mediaHub.matrixFallback')}</h2>
                <p>{matrix ? localizeDescription(matrix, locale) : t('mediaHub.entryMissing')}</p>
              </div>
              <button
                type="button"
                className="plugins-view__primary"
                disabled={!matrix}
                onClick={() => matrix && use(matrix)}
                data-testid="media-hub-use-matrix"
              >
                {t('mediaHub.start')}
              </button>
            </article>
          </div>
        </>
      )}
    </section>
  );
}

function localizeDescription(record: InstalledPluginRecord, locale: string): string {
  const i18n = record.manifest?.description_i18n as Record<string, string> | undefined;
  return (
    i18n?.[locale] ?? i18n?.['zh-CN'] ?? record.manifest?.description ?? record.id
  );
}
