import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { bundleCustomerLicense, resolveCustomerLicense } from "../license-seed.js";
import { copyBundledResourceTrees, resourcesRoot, winResources } from "../resources.js";
import {
  copyOptionalVelaCliBinary,
  resolveOptionalVelaCliBinary,
  resolveOptionalVelaCliOpenCodeCompanionTree,
} from "../vela-cli.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 5;

/** hashPath 对缺失路径直接抛;vendor/bakuan-engine 在上游检出里可以整体缺席,缺席也是合法键值。 */
async function hashPathIfExists(
  path: string,
  options: { ignoreDirectoryNames?: readonly string[] } = {},
): Promise<string | null> {
  if (!existsSync(path)) return null;
  return hashPath(path, options);
}

async function createResourceTreeCacheKey(config: ToolPackConfig): Promise<string> {
  const velaCliBin = await resolveOptionalVelaCliBinary({
    requireBundled: config.requireVelaCli,
  });
  const velaOpenCodeCompanion =
    velaCliBin == null
      ? null
      : await resolveOptionalVelaCliOpenCodeCompanionTree(velaCliBin);
  // 客户 license 内嵌进资源树,必须进键——否则「先打无客户包再打客户包」会命中同一棵缓存树,
  // 安装包里 license 静默丢失/串客户(electron-builder 缓存键只含 resourceTree.key)。
  const customerLicense = await resolveCustomerLicense(config);
  return hashJson({
    assetsCommunityPets: await hashPath(join(config.workspaceRoot, "assets", "community-pets")),
    assetsFrames: await hashPath(join(config.workspaceRoot, "assets", "frames")),
    // bakuan-engine 源码 + vendor 归档(python/wheels/ffmpeg/lark-cli)都进资源树,同样必须进键,
    // 不然换 vendor 重打包会静默复用旧缓存树。忽略集与 copyBakuanEngine 的排除项对齐。
    bakuanEngine: await hashPathIfExists(join(config.workspaceRoot, "bakuan-engine"), {
      ignoreDirectoryNames: [".venv", "data", "output", "__pycache__", ".pytest_cache", "node_modules"],
    }),
    bakuanVendor: await hashPathIfExists(join(resourcesRoot, "..", "vendor")),
    craft: await hashPath(join(config.workspaceRoot, "craft")),
    customerLicense: customerLicense?.raw ?? null,
    designSystems: await hashPath(join(config.workspaceRoot, "design-systems")),
    designTemplates: await hashPath(join(config.workspaceRoot, "design-templates")),
    node: "win.resource-tree",
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
      // 客户 license 在缓存树内落地(customer-license.json),键里已含 license 原文,客户切换会换树。
      await bundleCustomerLicense(config, resourceRoot);
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
