import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listPluginVersions,
  readPluginVersion,
  recordPluginVersion,
} from '../src/plugin-history.js';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function fresh(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-history-'));
  return root;
}

describe('plugin edit history', () => {
  it('records, lists (newest first), and reads back versions', async () => {
    const dir = await fresh();
    const v1 = await recordPluginVersion(dir, 'my-plugin', { skill: 'one', manifest: { name: 'my-plugin' } }, 1000);
    const v2 = await recordPluginVersion(dir, 'my-plugin', { skill: 'two', manifest: { name: 'my-plugin' } }, 2000);
    expect(v1).toBe('1000');
    expect(v2).toBe('2000');
    const versions = await listPluginVersions(dir, 'my-plugin');
    expect(versions.map((v) => v.id)).toEqual(['2000', '1000']);
    const back = await readPluginVersion(dir, 'my-plugin', '1000');
    expect(back?.skill).toBe('one');
    expect(back?.manifest).toEqual({ name: 'my-plugin' });
  });

  it('disambiguates same-tick saves instead of overwriting', async () => {
    const dir = await fresh();
    const a = await recordPluginVersion(dir, 'p', { skill: 'a', manifest: {} }, 5000);
    const b = await recordPluginVersion(dir, 'p', { skill: 'b', manifest: {} }, 5000);
    expect(a).toBe('5000');
    expect(b).toBe('5000-1');
    expect((await readPluginVersion(dir, 'p', '5000'))?.skill).toBe('a');
    expect((await readPluginVersion(dir, 'p', '5000-1'))?.skill).toBe('b');
  });

  it('prunes beyond the 20-version cap, dropping the oldest', async () => {
    const dir = await fresh();
    for (let i = 0; i < 23; i += 1) {
      await recordPluginVersion(dir, 'p', { skill: `v${i}`, manifest: {} }, 1000 + i);
    }
    const files = await readdir(path.join(dir, 'p'));
    expect(files.length).toBe(20);
    const versions = await listPluginVersions(dir, 'p');
    expect(versions[versions.length - 1]?.id).toBe('1003');
  });

  it('rejects unsafe plugin and version ids', async () => {
    const dir = await fresh();
    expect(await recordPluginVersion(dir, '../escape', { skill: 'x', manifest: {} })).toBeNull();
    expect(await readPluginVersion(dir, 'p', '../1000')).toBeNull();
    expect(await listPluginVersions(dir, 'Bad Id')).toEqual([]);
  });
});
