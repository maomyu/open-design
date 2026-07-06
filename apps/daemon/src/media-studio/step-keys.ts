/**
 * Studio API-key resolution — one configuration, two consumers.
 *
 * The 公众号 plugin already collects DAJIALA_API_KEY / QWEN_API_KEY /
 * GEMINI_API_KEY through 编辑插件 → 插件配置 (app-config `pluginConfig`),
 * with the workbench `.env` as the legacy base layer. The studio reads the
 * exact same two layers (editor values win) so keys configured once work in
 * both the plugin pipeline and the studio buttons.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginConfigEnvForPlugin, readAppConfig } from '../app-config.js';

const WECHAT_PLUGIN_ID = 'wechat-mp-publish';
const WORKBENCH_ENV_FILE = path.join(
  process.env.OD_WORKBENCH_DIR || path.join(os.homedir(), '.open-design', 'workbenches'),
  '多媒体自动发布',
  '.claude',
  'skills',
  'MY-wechat-shared',
  '.env',
);

async function parseEnvFile(file: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(file, 'utf8');
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function resolveStudioKeys(dataDir: string): Promise<Record<string, string>> {
  const [envFile, prefs] = await Promise.all([
    parseEnvFile(WORKBENCH_ENV_FILE),
    readAppConfig(dataDir),
  ]);
  // Editor-configured values override the workbench .env base.
  return { ...envFile, ...pluginConfigEnvForPlugin(prefs, WECHAT_PLUGIN_ID) };
}

export function missingKeyError(key: string): string {
  return `缺少 ${key}——去「插件」页编辑「公众号发布」插件的「插件配置」填上（od plugin config wechat-mp-publish 也行）`;
}
