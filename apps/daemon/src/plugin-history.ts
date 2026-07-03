// Plugin edit history — the safety net under "保存并发布" and AI rewrites.
// Every source save snapshots the plugin's PRE-EDIT files (SKILL.md +
// open-design.json) into `<dataDir>/plugin-history/<pluginId>/<versionId>.json`
// so any save — hand edit, AI assist, or rollback itself — can be undone.
// File-based (no SQLite migration) because versions are plugin-folder
// mirrors, the same philosophy as "the plugin IS the asset".

import path from 'node:path';
import { promises as fsp } from 'node:fs';

export interface PluginVersionRecord {
  id: string;
  savedAt: number;
  skill: string;
  manifest: unknown;
}

export interface PluginVersionSummaryRow {
  id: string;
  savedAt: number;
}

// Keep enough depth to recover from a bad streak of AI edits without letting
// a hot editing session grow the folder unbounded.
const MAX_VERSIONS_PER_PLUGIN = 20;

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_VERSION_ID = /^[0-9]+(?:-[0-9]+)?$/;

function pluginDir(historyRoot: string, pluginId: string): string | null {
  if (!SAFE_PLUGIN_ID.test(pluginId)) return null;
  return path.join(historyRoot, pluginId);
}

/** Snapshot the current (pre-edit) plugin source. Returns the version id. */
export async function recordPluginVersion(
  historyRoot: string,
  pluginId: string,
  input: { skill: string; manifest: unknown },
  now = Date.now(),
): Promise<string | null> {
  const dir = pluginDir(historyRoot, pluginId);
  if (!dir) return null;
  await fsp.mkdir(dir, { recursive: true });
  // Millisecond timestamps collide when saves land in the same tick (tests,
  // scripted CLI loops) — suffix a counter until the name is free.
  let id = String(now);
  for (let n = 1; ; n += 1) {
    try {
      await fsp.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({ id, savedAt: now, skill: input.skill, manifest: input.manifest }) + '\n',
        { encoding: 'utf8', flag: 'wx' },
      );
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      id = `${now}-${n}`;
    }
  }
  await pruneOldVersions(dir);
  return id;
}

async function pruneOldVersions(dir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  if (entries.length <= MAX_VERSIONS_PER_PLUGIN) return;
  // Version ids sort chronologically as strings of equal-length timestamps —
  // but pad-safe numeric compare keeps it correct across length changes.
  entries.sort((a, b) => parseFloat(a) - parseFloat(b));
  const excess = entries.slice(0, entries.length - MAX_VERSIONS_PER_PLUGIN);
  for (const name of excess) {
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

export async function listPluginVersions(
  historyRoot: string,
  pluginId: string,
): Promise<PluginVersionSummaryRow[]> {
  const dir = pluginDir(historyRoot, pluginId);
  if (!dir) return [];
  let entries: string[] = [];
  try {
    entries = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PluginVersionSummaryRow[] = [];
  for (const name of entries) {
    const id = name.replace(/\.json$/, '');
    if (!SAFE_VERSION_ID.test(id)) continue;
    out.push({ id, savedAt: Math.floor(parseFloat(id)) });
  }
  // Newest first.
  out.sort((a, b) => parseFloat(b.id) - parseFloat(a.id));
  return out;
}

export async function readPluginVersion(
  historyRoot: string,
  pluginId: string,
  versionId: string,
): Promise<PluginVersionRecord | null> {
  const dir = pluginDir(historyRoot, pluginId);
  if (!dir || !SAFE_VERSION_ID.test(versionId)) return null;
  try {
    const raw = await fsp.readFile(path.join(dir, `${versionId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as PluginVersionRecord;
    if (typeof parsed?.skill !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
