import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { copyBundledResourceTrees, winResources } from "../resources.js";
import {
  copyOptionalVelaCliBinary,
  resolveOptionalVelaCliBinary,
  resolveOptionalVelaCliOpenCodeCompanionTree,
} from "../vela-cli.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 5;

/** 双包交付烤入(2026-07-19,与 mac/app.ts 对齐):OD_PACK_LICENSE_FILE / OD_PACK_SEED_FILE
 *  指向的文件烤进包资源(resources/open-design/{license,seed}.json)。win 此前完全没有
 *  这段——打出的包无 license → daemon 全解锁,客户机上文章包功能全冒出来(实测抓获)。 */
function bakedLicenseFile(): string { return (process.env.OD_PACK_LICENSE_FILE ?? "").trim(); }
function bakedSeedFile(): string { return (process.env.OD_PACK_SEED_FILE ?? "").trim(); }

async function createResourceTreeCacheKey(config: ToolPackConfig): Promise<string> {
  const velaCliBin = await resolveOptionalVelaCliBinary({
    requireBundled: config.requireVelaCli,
  });
  const velaOpenCodeCompanion =
    velaCliBin == null
      ? null
      : await resolveOptionalVelaCliOpenCodeCompanionTree(velaCliBin);
  return hashJson({
    assetsCommunityPets: await hashPath(join(config.workspaceRoot, "assets", "community-pets")),
    assetsFrames: await hashPath(join(config.workspaceRoot, "assets", "frames")),
    craft: await hashPath(join(config.workspaceRoot, "craft")),
    designSystems: await hashPath(join(config.workspaceRoot, "design-systems")),
    designTemplates: await hashPath(join(config.workspaceRoot, "design-templates")),
    node: "win.resource-tree",
    bakedLicense: bakedLicenseFile() ? await hashPath(bakedLicenseFile()) : null,
    bakedSeed: bakedSeedFile() ? await hashPath(bakedSeedFile()) : null,
    pluginOfficial: await hashPath(join(config.workspaceRoot, "plugins", "_official")),
    pluginRegistry: await hashPath(join(config.workspaceRoot, "plugins", "registry")),
    promptTemplates: await hashPath(join(config.workspaceRoot, "prompt-templates")),
    schemaVersion: RESOURCE_TREE_CACHE_SCHEMA_VERSION,
    skills: await hashPath(join(config.workspaceRoot, "skills")),
    requireVelaCli: config.requireVelaCli,
    velaCliBin: velaCliBin ? await hashPath(velaCliBin) : null,
    velaOpenCodeCompanion: velaOpenCodeCompanion
      ? await hashPath(velaOpenCodeCompanion)
      : null,
  });
}

export type ResourceTreeResult = {
  key: string;
  resourceRoot: string;
};

export async function prepareResourceTree(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  options: { materialize: boolean },
): Promise<ResourceTreeResult> {
  const key = await createResourceTreeCacheKey(config);
  const node = {
    id: "win.resource-tree",
    key,
    outputs: ["open-design"],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ResourceTreeCacheMetadata> => {
      const resourceRoot = join(entryRoot, "open-design");
      await mkdir(resourceRoot, { recursive: true });
      await copyBundledResourceTrees({
        workspaceRoot: config.workspaceRoot,
        resourceRoot,
      });
      await copyOptionalVelaCliBinary({
        platform: "win",
        requireBundled: config.requireVelaCli,
        resourceRoot,
      });
      // 双包交付:license/seed 烤进包资源(daemon 数据目录无 license 时回落读它)。
      if (bakedLicenseFile()) {
        await copyFile(bakedLicenseFile(), join(resourceRoot, "license.json"));
        process.stderr.write(`[tools-pack win] baked license → resources/open-design/license.json (from ${bakedLicenseFile()})\n`);
      }
      if (bakedSeedFile()) {
        await copyFile(bakedSeedFile(), join(resourceRoot, "seed.json"));
        process.stderr.write(`[tools-pack win] baked seed → resources/open-design/seed.json (from ${bakedSeedFile()})\n`);
      }
      return { resourceName: "open-design" };
    },
  };
  const manifest = await cache.acquire({
    materialize: options.materialize ? [{ from: "open-design", to: paths.resourceRoot }] : [],
    node,
  });
  return {
    key,
    resourceRoot: options.materialize ? paths.resourceRoot : join(manifest.entryPath, "open-design"),
  };
}

export async function copyWinIcon(paths: WinPaths): Promise<void> {
  await mkdir(dirname(paths.winIconPath), { recursive: true });
  await cp(winResources.icon, paths.winIconPath);
}
