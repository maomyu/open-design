/**
 * Studio API-key resolution — one place to configure, everywhere to use.
 *
 * Layer order (low → high)：
 *   1. workbench `.env`（历史兜底层，客户早期配置继续生效）
 *   2. 设置 → 媒体生成 provider keys（media-config.json，按厂商统一管理——
 *      dashscope→QWEN_API_KEY、dajiala→DAJIALA_API_KEY、volcengine→ARK_API_KEY、
 *      nanobanana→GEMINI_API_KEY）。**唯一的配置界面**。
 *
 * 2026-07-08 用户拍板移除「插件配置」覆盖层：插件动线已被三创作台替代，
 * 多一层覆盖只会造成「设置里改了为什么不生效」的排查陷阱。
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProviderConfig } from '../media-config.js';

/** 设置界面按厂商配置的 key → 创作台使用的环境变量名。 */
const MEDIA_PROVIDER_KEY_MAP: Array<[providerId: string, envKey: string]> = [
  ['dashscope', 'QWEN_API_KEY'],
  ['dajiala', 'DAJIALA_API_KEY'],
  ['volcengine', 'ARK_API_KEY'],
  ['nanobanana', 'GEMINI_API_KEY'],
];

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

async function mediaConfigKeys(projectRoot: string | undefined): Promise<Record<string, string>> {
  if (!projectRoot) return {};
  const out: Record<string, string> = {};
  await Promise.all(
    MEDIA_PROVIDER_KEY_MAP.map(async ([providerId, envKey]) => {
      try {
        const cfg = await resolveProviderConfig(projectRoot, providerId);
        if (cfg.apiKey) out[envKey] = cfg.apiKey;
      } catch {
        /* provider unknown / config unreadable → skip */
      }
    }),
  );
  return out;
}

export async function resolveStudioKeys(_dataDir: string, projectRoot?: string): Promise<Record<string, string>> {
  const [envFile, mediaKeys] = await Promise.all([
    parseEnvFile(WORKBENCH_ENV_FILE),
    mediaConfigKeys(projectRoot),
  ]);
  // 设置界面（media-config）盖过 .env 兜底。
  return { ...envFile, ...mediaKeys };
}

export function missingKeyError(key: string): string {
  return `缺少 ${key}——去「设置 → 媒体生成」按厂商填一次即可（阿里云百炼=千问生图、大家来=选题数据、Volcengine Ark=火山生图、Nano Banana=Gemini）`;
}
