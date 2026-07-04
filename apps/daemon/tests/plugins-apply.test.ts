// Daemon `applyPlugin` purity test (plan F4).
//
// applyPlugin must:
//   - Compute a deterministic snapshot for the same inputs.
//   - Refuse to mutate the registry / FS / SQLite — caller owns persistence.
//   - Throw MissingInputError when a required input is absent.

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applyPlugin, MissingInputError } from '../src/plugins/apply.js';
import { defaultRegistryRoots } from '../src/plugins/registry.js';
import { TRUSTED_DEFAULT_CAPABILITIES } from '../src/plugins/trust.js';
import type { ContextItem, InstalledPluginRecord } from '@open-design/contracts';

function pluginFixture(extra: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    id: 'sample-plugin',
    title: 'Sample Plugin',
    version: '1.0.0',
    sourceKind: 'local',
    source: '/tmp/sample-plugin',
    sourceMarketplaceId: undefined,
    pinnedRef: undefined,
    sourceDigest: undefined,
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: '/tmp/sample-plugin',
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: 'sample-plugin',
      title: 'Sample Plugin',
      version: '1.0.0',
      description: 'Fixture for apply tests.',
      od: {
        kind: 'skill',
        taskKind: 'new-generation',
        useCase: { query: 'Generate a {{topic}} brief.' },
        inputs: [
          { name: 'topic', type: 'string', required: true },
          { name: 'audience', type: 'string', default: 'general' },
        ],
        context: {
          skills: [{ ref: 'sample-skill' }],
          atoms: ['todo-write'],
        },
        capabilities: ['prompt:inject'],
      },
    },
    ...extra,
  };
}

const REGISTRY = {
  skills: [{ id: 'sample-skill', title: 'Sample Skill' }],
  designSystems: [],
  craft: [],
  atoms: [{ id: 'todo-write', label: 'Todo write' }],
};

describe('applyPlugin', () => {
  it('produces a deterministic snapshot for the same inputs', () => {
    const a = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    const b = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    expect(a.manifestSourceDigest).toBe(b.manifestSourceDigest);
    expect(a.result.appliedPlugin.manifestSourceDigest).toBe(b.result.appliedPlugin.manifestSourceDigest);
    expect(a.result.appliedPlugin.appliedAt).not.toBe(0);
  });

  it('throws MissingInputError when a required input is missing', () => {
    expect(() => applyPlugin({ plugin: pluginFixture(), inputs: {}, registry: REGISTRY })).toThrow(MissingInputError);
  });

  // Design doc 2026-07-04 (公众号多账号凭证) spec ⑥ — with 2+ account profiles
  // the hydrated `account` select turns required SERVER-SIDE, so a CLI/direct
  // API apply without a pick gets the same 422 the composer enforces visually.
  it('requires the account input when 2+ account profiles exist (dynamic required)', () => {
    const base = pluginFixture();
    const plugin: InstalledPluginRecord = {
      ...base,
      manifest: {
        ...base.manifest,
        od: {
          ...base.manifest.od,
          accounts: { credentialKeys: ['WECHAT_APPID'] },
          inputs: [
            { name: 'topic', type: 'string', required: true },
            { name: 'account', type: 'select', optionsFrom: 'accounts' },
          ],
        },
      },
    };
    const two = ['报考日记', '考研日记'];
    expect(() =>
      applyPlugin({ plugin, inputs: { topic: 'design' }, registry: REGISTRY, accountNames: two }),
    ).toThrow(MissingInputError);
    // Picking one satisfies it; a single configured account auto-defaults.
    const picked = applyPlugin({
      plugin, inputs: { topic: 'design', account: '报考日记' }, registry: REGISTRY, accountNames: two,
    });
    expect(picked.result.appliedPlugin.inputs.account).toBe('报考日记');
    const single = applyPlugin({
      plugin, inputs: { topic: 'design' }, registry: REGISTRY, accountNames: ['唯一号'],
    });
    expect(single.result.appliedPlugin.inputs.account).toBe('唯一号');
  });

  it('coerces optional inputs by defaulting when blank', () => {
    const result = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    expect(result.result.appliedPlugin.inputs.audience).toBe('general');
  });

  it('resolves localized use-case queries at apply time', () => {
    const base = pluginFixture();
    const result = applyPlugin({
      plugin: {
        ...base,
        manifest: {
          ...base.manifest,
          od: {
            ...base.manifest.od,
            useCase: {
              query: {
                en: 'Generate a {{topic}} brief.',
                'zh-CN': '生成一份关于 {{topic}} 的简报。',
              },
            },
          },
        },
      },
      inputs: { topic: 'design' },
      registry: REGISTRY,
      locale: 'zh-CN',
    });

    expect(result.result.query).toBe('生成一份关于 {{topic}} 的简报。');
    expect(result.result.appliedPlugin.query).toBe('生成一份关于 {{topic}} 的简报。');
  });

  it('grants trusted defaults plus required caps for a trusted plugin', () => {
    const result = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    for (const cap of TRUSTED_DEFAULT_CAPABILITIES) {
      expect(result.result.capabilitiesGranted).toContain(cap);
    }
  });

  it('emits skill+atom items in resolvedContext.items', () => {
    const result = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    const kinds = result.result.contextItems.map((c: ContextItem) => c.kind);
    expect(kinds).toContain('skill');
    expect(kinds).toContain('atom');
  });

  it('does not require a registry roots argument (no FS access at apply time)', () => {
    // Sanity: the function must not reach for the on-disk plugin folder.
    const roots = defaultRegistryRoots();
    const expectedDataDir = path.resolve(process.env.OD_DATA_DIR ?? path.join(process.cwd(), '.od'));
    expect(roots.userPluginsRoot).toBe(path.join(expectedDataDir, 'plugins'));
    const result = applyPlugin({ plugin: pluginFixture(), inputs: { topic: 'design' }, registry: REGISTRY });
    expect(result.result.appliedPlugin.pluginId).toBe('sample-plugin');
  });
});

describe('applyPlugin 自动模式 (runMode)', () => {
  // 自动模式 rides on the applied query so the instructions live in the
  // conversation for every later run, and stamps the snapshot so the daemon
  // composes auto-advance stage notes at run time.
  it("appends the AUTO block to query and stamps snapshot.runMode on runMode: 'auto'", () => {
    const result = applyPlugin({
      plugin: pluginFixture(),
      inputs: { topic: 'design' },
      registry: REGISTRY,
      runMode: 'auto',
    });
    expect(result.result.query).toContain('【自动模式】');
    // The one gate auto mode keeps: outward publish still confirms once.
    expect(result.result.query).toContain('对外发布');
    // Missing-config recovery protocol: pause, configure, reply 继续.
    expect(result.result.query).toContain('继续');
    expect(result.result.appliedPlugin.query).toContain('【自动模式】');
    expect(result.result.appliedPlugin.runMode).toBe('auto');
  });

  it('default apply stays on ask semantics — no AUTO block, no runMode stamp', () => {
    const result = applyPlugin({
      plugin: pluginFixture(),
      inputs: { topic: 'design' },
      registry: REGISTRY,
    });
    expect(result.result.query).not.toContain('【自动模式】');
    expect(result.result.appliedPlugin.runMode).toBeUndefined();
  });
});
