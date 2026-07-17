// 打包预填种子(2026-07-18 用户拍板:客户定制包装上即有企业知识库与发布账号,
// 免二次配置)。打包时 OD_PACK_SEED_FILE 烤进包资源 seed.json;daemon 每次启动
// 幂等导入:知识条目按 名称 查重、账号按 平台+名称 查重——已存在(含客户后来
// 改过的)绝不覆盖,只补缺。种子含账号凭证,文件不进 git(放客户目录,打包时引用)。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { createKnowledge, listKnowledge } from './media-studio/store.js';
import { upsertPlatformAccount } from './account-routes.js';
import { readAppConfig } from './app-config.js';

interface SeedKnowledge { name: string; category: string; contentMd: string }
interface SeedAccount { platform: string; name: string; credentials?: Record<string, string>; style?: { persona?: string; samples?: string } }
interface SeedFile { knowledge?: SeedKnowledge[]; accounts?: SeedAccount[] }

export async function applyBundledSeed(
  db: BetterSqlite3.Database,
  dataDir: string,
  resourceRoot: string | null,
): Promise<void> {
  if (!resourceRoot) return;
  let seed: SeedFile;
  try {
    seed = JSON.parse(await readFile(path.join(resourceRoot, 'seed.json'), 'utf8')) as SeedFile;
  } catch {
    return; // 无种子文件 = 非定制包,静默跳过
  }
  // 知识条目:按名称幂等(客户删了/改了都不重灌;只在完全缺失时补)。
  try {
    const existing = new Set(listKnowledge(db, 'global').map((k) => k.name));
    for (const k of seed.knowledge ?? []) {
      if (!k?.name?.trim() || !k?.contentMd?.trim() || existing.has(k.name)) continue;
      createKnowledge(db, 'global', {
        name: k.name.trim(),
        contentMd: k.contentMd,
        accountId: null,
        ...(k.category ? { category: k.category } : {}),
      });
      console.log(`[seed] knowledge + ${k.name}`);
    }
  } catch (err) {
    console.warn('[seed] knowledge import failed:', err instanceof Error ? err.message : String(err));
  }
  // 发布账号:按 平台+名称 幂等。
  for (const a of seed.accounts ?? []) {
    if (!a?.platform || !a?.name?.trim()) continue;
    try {
      const cfg = await readAppConfig(dataDir);
      const all = (cfg.platformAccounts ?? {}) as Record<string, Array<{ name?: string }>>;
      const taken = (all[a.platform] ?? []).some((x) => x?.name === a.name);
      if (taken) continue;
      const r = await upsertPlatformAccount(dataDir, a.platform, {
        name: a.name.trim(),
        ...(a.credentials ? { credentials: a.credentials } : {}),
        ...(a.style ? { style: a.style } : {}),
      });
      if (r.ok) console.log(`[seed] account + ${a.platform}/${a.name}`);
    } catch (err) {
      console.warn(`[seed] account ${a.platform}/${a.name} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}
