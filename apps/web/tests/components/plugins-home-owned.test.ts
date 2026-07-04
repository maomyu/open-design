// Ownership classification for the plugins gallery source filter. A plugin the
// operator AUTHORED (created in the editor → sourceKind 'user', or scoped to a
// project) must count as "owned" so it shows under the default 内置插件 filter
// — otherwise it falls into the "official" (upstream) bucket and disappears
// from the gallery even though it's installed. Regression for user-created
// plugins vanishing from the Plugins page.

import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord, PluginSourceKind } from '@open-design/contracts';
import { isProductOwned, PRODUCT_PLUGIN_TAG } from '../../src/components/plugins-home/usePluginFacets';

function fixture(sourceKind: PluginSourceKind, tags?: string[]): InstalledPluginRecord {
  return {
    id: 'p',
    title: 'p',
    version: '0.1.0',
    sourceKind,
    source: '/tmp',
    trust: 'trusted',
    capabilitiesGranted: [],
    manifest: { name: 'p', version: '0.1.0', ...(tags ? { tags } : {}) },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

describe('isProductOwned', () => {
  it('treats editor-created (user) and project plugins as owned regardless of tags', () => {
    expect(isProductOwned(fixture('user'))).toBe(true);
    expect(isProductOwned(fixture('project'))).toBe(true);
  });

  it('treats tagged bundled plugins as owned', () => {
    expect(isProductOwned(fixture('bundled', [PRODUCT_PLUGIN_TAG]))).toBe(true);
  });

  it('leaves externally-sourced installs without the tag as official (not owned)', () => {
    expect(isProductOwned(fixture('bundled'))).toBe(false);
    expect(isProductOwned(fixture('github'))).toBe(false);
    expect(isProductOwned(fixture('marketplace'))).toBe(false);
  });
});
