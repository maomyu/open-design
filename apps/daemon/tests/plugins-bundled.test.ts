// Phase 4 / spec §23.3.5 — bundled plugin boot walker.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migratePlugins } from '../src/plugins/persistence.js';
import { listInstalledPlugins } from '../src/plugins/registry.js';
import { registerBundledPlugins, registerUserPlugins } from '../src/plugins/bundled.js';

let db: Database.Database;
let tmpRoot: string;

const SAMPLE_MANIFEST = (id: string) =>
  JSON.stringify({
    $schema: 'https://open-design.ai/schemas/plugin.v1.json',
    name: id,
    title: id,
    version: '0.1.0',
    description: `${id} bundled fixture`,
    license: 'MIT',
    od: { kind: 'atom', capabilities: ['prompt:inject'] },
  });

const SAMPLE_SKILL = (id: string) => `---\nname: ${id}\ndescription: bundled fixture\n---\n# ${id}\n`;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'od-bundled-'));
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
  `);
  migratePlugins(db);
});

afterEach(async () => {
  db.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('registerBundledPlugins', () => {
  it('registers every <bundledRoot>/<tier>/<id>/ folder under source_kind=bundled', async () => {
    // Build a layout with one atom + one scenario:
    //   <bundledRoot>/atoms/discovery-question-form/{open-design.json,SKILL.md}
    //   <bundledRoot>/scenarios/od-new-generation/{open-design.json,SKILL.md}
    const atomDir = path.join(tmpRoot, 'atoms', 'discovery-question-form');
    const sceneDir = path.join(tmpRoot, 'scenarios', 'od-new-generation');
    await mkdir(atomDir, { recursive: true });
    await mkdir(sceneDir, { recursive: true });
    await writeFile(path.join(atomDir, 'open-design.json'), SAMPLE_MANIFEST('discovery-question-form'));
    await writeFile(path.join(atomDir, 'SKILL.md'), SAMPLE_SKILL('discovery-question-form'));
    await writeFile(path.join(sceneDir, 'open-design.json'), SAMPLE_MANIFEST('od-new-generation'));
    await writeFile(path.join(sceneDir, 'SKILL.md'), SAMPLE_SKILL('od-new-generation'));

    const result = await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(result.registered.map((r) => r.id).sort()).toEqual(['discovery-question-form', 'od-new-generation']);
    const installed = listInstalledPlugins(db);
    expect(installed.length).toBe(2);
    for (const row of installed) {
      expect(row.sourceKind).toBe('bundled');
      expect(row.trust).toBe('bundled');
    }
  });

  it('can stamp official registry provenance on bundled preinstalls', async () => {
    const folder = path.join(tmpRoot, 'scenarios', 'starter');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'open-design.json'), SAMPLE_MANIFEST('starter'));
    await writeFile(path.join(folder, 'SKILL.md'), SAMPLE_SKILL('starter'));

    const result = await registerBundledPlugins({
      db,
      bundledRoot: tmpRoot,
      marketplaceProvenance: {
        sourceMarketplaceId: 'official',
        marketplaceTrust: 'official',
        entryNamePrefix: 'open-design',
      },
    });

    expect(result.registered[0]?.sourceKind).toBe('bundled');
    expect(result.registered[0]?.sourceMarketplaceId).toBe('official');
    expect(result.registered[0]?.sourceMarketplaceEntryName).toBe('open-design/starter');
    expect(result.registered[0]?.sourceMarketplaceEntryVersion).toBe('0.1.0');
    expect(result.registered[0]?.marketplaceTrust).toBe('official');
    expect(result.registered[0]?.resolvedSource).toBe(folder);

    const [row] = listInstalledPlugins(db);
    expect(row?.sourceMarketplaceId).toBe('official');
    expect(row?.sourceMarketplaceEntryName).toBe('open-design/starter');
  });

  it('also registers a direct <bundledRoot>/<plugin-id>/ folder', async () => {
    // Direct layout (no tier): <bundledRoot>/sample-plugin/...
    const folder = path.join(tmpRoot, 'sample-plugin');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'open-design.json'), SAMPLE_MANIFEST('sample-plugin'));
    await writeFile(path.join(folder, 'SKILL.md'), SAMPLE_SKILL('sample-plugin'));

    const result = await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(result.registered.map((r) => r.id)).toEqual(['sample-plugin']);
  });

  it('is idempotent — re-running upserts the same row', async () => {
    const folder = path.join(tmpRoot, 'atoms', 'sample');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'open-design.json'), SAMPLE_MANIFEST('sample'));
    await writeFile(path.join(folder, 'SKILL.md'), SAMPLE_SKILL('sample'));

    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(listInstalledPlugins(db).length).toBe(1);
  });

  it('returns empty result when bundledRoot does not exist', async () => {
    const result = await registerBundledPlugins({
      db,
      bundledRoot: path.join(tmpRoot, 'does-not-exist'),
    });
    expect(result.registered).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips folders without open-design.json without warning', async () => {
    const folder = path.join(tmpRoot, 'atoms', 'no-manifest');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'README.md'), '# nothing\n');
    const result = await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(result.registered).toEqual([]);
  });

  it('prunes bundled rows whose folder disappeared, leaving user plugins alone', async () => {
    // Boot 1: two bundled plugins ship.
    const keptDir = path.join(tmpRoot, 'content', 'kept-plugin');
    const removedDir = path.join(tmpRoot, 'content', 'removed-plugin');
    for (const [dir, id] of [
      [keptDir, 'kept-plugin'],
      [removedDir, 'removed-plugin'],
    ] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'open-design.json'), SAMPLE_MANIFEST(id));
      await writeFile(path.join(dir, 'SKILL.md'), SAMPLE_SKILL(id));
    }
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(listInstalledPlugins(db).map((r) => r.id).sort()).toEqual([
      'kept-plugin',
      'removed-plugin',
    ]);

    // A user-installed row must survive the prune untouched.
    db.prepare(
      `UPDATE installed_plugins SET source_kind = 'local-folder', trust = 'unlisted' WHERE id = 'removed-plugin'`,
    ).run();
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(listInstalledPlugins(db).map((r) => r.id).sort()).toEqual([
      'kept-plugin',
      'removed-plugin',
    ]);
    db.prepare(
      `UPDATE installed_plugins SET source_kind = 'bundled', trust = 'bundled' WHERE id = 'removed-plugin'`,
    ).run();

    // Boot 2: the folder was deleted upstream (plugin removed/renamed/
    // merged). The stale bundled row must be pruned, not survive as a
    // ghost with a dead fs_path.
    await rm(removedDir, { recursive: true, force: true });
    const result = await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    expect(result.pruned).toEqual(['removed-plugin']);
    expect(listInstalledPlugins(db).map((r) => r.id)).toEqual(['kept-plugin']);
  });

  it('restores a user shadow of a bundled plugin after the bundled walker clobbers it', async () => {
    // The bundled plugin ships…
    const bundledDir = path.join(tmpRoot, 'content', 'shadowed-plugin');
    await mkdir(bundledDir, { recursive: true });
    await writeFile(path.join(bundledDir, 'open-design.json'), SAMPLE_MANIFEST('shadowed-plugin'));
    await writeFile(path.join(bundledDir, 'SKILL.md'), SAMPLE_SKILL('shadowed-plugin'));
    // …and the user saved an edited copy under the user plugins root.
    const userRoot = path.join(tmpRoot, 'user-plugins');
    const userDir = path.join(userRoot, 'shadowed-plugin');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'open-design.json'), SAMPLE_MANIFEST('shadowed-plugin'));
    await writeFile(path.join(userDir, 'SKILL.md'), SAMPLE_SKILL('shadowed-plugin'));

    // Boot order: bundled walker upserts sourceKind='bundled' (this is the
    // clobber), then the user walker re-registers the shadow — the on-disk
    // user copy must win.
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    const clobbered = listInstalledPlugins(db).find((r) => r.id === 'shadowed-plugin');
    expect(clobbered?.sourceKind).toBe('bundled');

    const result = await registerUserPlugins({ db, userPluginsRoot: userRoot });
    expect(result.registered.map((r) => r.id)).toEqual(['shadowed-plugin']);
    const restored = listInstalledPlugins(db).find((r) => r.id === 'shadowed-plugin');
    expect(restored?.sourceKind).toBe('user');
    expect(restored?.trust).toBe('trusted');
    expect(restored?.fsPath).toBe(userDir);
  });

  it('user walker returns empty when the user plugins root does not exist', async () => {
    const result = await registerUserPlugins({
      db,
      userPluginsRoot: path.join(tmpRoot, 'no-user-root'),
    });
    expect(result.registered).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('prunes a user row whose folder was deleted, leaving bundled + other user rows', async () => {
    const userRoot = path.join(tmpRoot, 'user-plugins');
    // A bundled plugin ships…
    const bundledDir = path.join(tmpRoot, 'content', 'bundled-keeper');
    await mkdir(bundledDir, { recursive: true });
    await writeFile(path.join(bundledDir, 'open-design.json'), SAMPLE_MANIFEST('bundled-keeper'));
    await writeFile(path.join(bundledDir, 'SKILL.md'), SAMPLE_SKILL('bundled-keeper'));
    // …and the user has two self-authored plugins.
    for (const id of ['user-keep', 'user-drop']) {
      const dir = path.join(userRoot, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'open-design.json'), SAMPLE_MANIFEST(id));
      await writeFile(path.join(dir, 'SKILL.md'), SAMPLE_SKILL(id));
    }
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    await registerUserPlugins({ db, userPluginsRoot: userRoot });
    expect(listInstalledPlugins(db).map((r) => r.id).sort()).toEqual([
      'bundled-keeper',
      'user-drop',
      'user-keep',
    ]);

    // The user deletes 'user-drop' from the editor (folder removed).
    await rm(path.join(userRoot, 'user-drop'), { recursive: true, force: true });
    await registerBundledPlugins({ db, bundledRoot: tmpRoot });
    const result = await registerUserPlugins({ db, userPluginsRoot: userRoot });
    expect(result.pruned).toEqual(['user-drop']);
    // bundled plugin and the surviving user plugin are untouched.
    expect(listInstalledPlugins(db).map((r) => r.id).sort()).toEqual([
      'bundled-keeper',
      'user-keep',
    ]);
  });
});
