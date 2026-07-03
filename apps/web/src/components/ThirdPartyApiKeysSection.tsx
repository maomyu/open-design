// Third-party API key management (Integrations → Connectors tab).
//
// Edits the daemon-side `thirdPartyApiKeys` app-config field: a flat
// KEY_NAME → secret map saved locally in app-config.json and injected as
// environment variables into spawned agent child processes (see
// `apps/daemon/src/app-config.ts#configuredEnvForAgentSpawn`). The values
// never leave this machine, so the section talks to /api/app-config
// directly instead of riding the localStorage-backed AppConfig sync —
// secrets should not be mirrored into browser storage.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';
import styles from './ThirdPartyApiKeysSection.module.css';

const KEY_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

interface KeyRow {
  /** Stable local id so React keys survive row removal/reordering. */
  id: number;
  key: string;
  value: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function ThirdPartyApiKeysSection() {
  const t = useT();
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const nextIdRef = useRef(0);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/app-config');
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          config?: { thirdPartyApiKeys?: Record<string, string> };
        };
        if (cancelled) return;
        const entries = Object.entries(data?.config?.thirdPartyApiKeys ?? {});
        setRows(
          entries.map(([key, value]) => ({ id: nextIdRef.current++, key, value })),
        );
      } catch {
        // Daemon offline — leave the empty state; saving will surface the error.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current != null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const updateRow = (id: number, patch: Partial<Pick<KeyRow, 'key' | 'value'>>) => {
    setRows((curr) => curr.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
    setSaveStatus('idle');
  };

  const addRow = () => {
    setRows((curr) => [...curr, { id: nextIdRef.current++, key: '', value: '' }]);
    setDirty(true);
    setSaveStatus('idle');
  };

  const removeRow = (id: number) => {
    setRows((curr) => curr.filter((r) => r.id !== id));
    setDirty(true);
    setSaveStatus('idle');
  };

  const isRowKeyInvalid = (row: KeyRow): boolean => {
    const key = row.key.trim();
    if (!key) return false; // blank rows are simply skipped on save
    return !KEY_NAME_PATTERN.test(key);
  };

  const hasInvalidKey = rows.some(isRowKeyInvalid);

  const handleSave = async () => {
    if (saveStatus === 'saving' || hasInvalidKey) return;
    setSaveStatus('saving');
    const map: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || !value) continue;
      map[key] = value;
    }
    try {
      const resp = await fetch('/api/app-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        // An empty map clears the stored field on the daemon side.
        body: JSON.stringify({ thirdPartyApiKeys: map }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setDirty(false);
      setSaveStatus('saved');
      if (savedTimerRef.current != null) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  return (
    <section
      className={`settings-section ${styles.section}`}
      aria-labelledby="third-party-api-keys-title"
      data-testid="third-party-api-keys-section"
    >
      <h3 id="third-party-api-keys-title" className={styles.title}>
        {t('integrations.apiKeys.title')}
      </h3>
      <p className={styles.desc}>{t('integrations.apiKeys.desc')}</p>

      {loading ? null : rows.length === 0 ? (
        <p className={styles.empty}>
          {t('integrations.apiKeys.empty')}{' '}
          {t('integrations.apiKeys.tikhubHint')}{' '}
          <a href="https://api.tikhub.io/" target="_blank" rel="noreferrer">
            https://api.tikhub.io/
          </a>
        </p>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => {
            const invalid = isRowKeyInvalid(row);
            return (
              <div key={row.id} className={styles.row}>
                <input
                  type="text"
                  className={styles.keyInput}
                  value={row.key}
                  placeholder={t('integrations.apiKeys.keyPlaceholder')}
                  spellCheck={false}
                  autoCapitalize="characters"
                  aria-invalid={invalid || undefined}
                  onChange={(e) => updateRow(row.id, { key: e.target.value })}
                />
                <input
                  type="password"
                  className={styles.valueInput}
                  value={row.value}
                  placeholder={t('integrations.apiKeys.valuePlaceholder')}
                  autoComplete="off"
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                />
                <button
                  type="button"
                  className={`ghost ${styles.removeBtn}`}
                  title={t('integrations.apiKeys.remove')}
                  aria-label={t('integrations.apiKeys.remove')}
                  onClick={() => removeRow(row.id)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {hasInvalidKey ? (
        <p className={styles.error} role="alert">
          {t('integrations.apiKeys.invalidKey')}
        </p>
      ) : null}
      {saveStatus === 'error' ? (
        <p className={styles.error} role="alert">
          {t('integrations.apiKeys.saveFailed')}
        </p>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className="ghost" onClick={addRow} disabled={loading}>
          <Icon name="plus" size={12} />
          <span>{t('integrations.apiKeys.add')}</span>
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void handleSave()}
          disabled={loading || !dirty || hasInvalidKey || saveStatus === 'saving'}
        >
          {saveStatus === 'saving' ? (
            <>
              <Icon name="spinner" size={12} className="icon-spin" />
              <span>{t('integrations.apiKeys.saving')}</span>
            </>
          ) : saveStatus === 'saved' ? (
            <>
              <Icon name="check" size={12} />
              <span>{t('integrations.apiKeys.saved')}</span>
            </>
          ) : (
            t('integrations.apiKeys.save')
          )}
        </button>
      </div>
    </section>
  );
}
