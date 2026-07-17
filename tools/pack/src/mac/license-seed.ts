import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolPackConfig } from "../config.js";

type CustomerManifest = { customer?: string; slug?: string; aliases?: string[] };

/**
 * 按客户内嵌 license（定制打包核心步骤，2026-07-16）。
 *
 * 客户从环境变量 `OD_PACK_CUSTOMER` 指定（slug 或别名，如 `翟总` / `zhongguoweiao`）。
 * 命中 `customers/<客户>/manifest.json` 后，把同目录**已签发**的 `license.json` 拷进
 * 打包运行时的数据目录（`<runtime.namespaceRoot>/data/license.json`）——daemon 启动读
 * 它 → 按功能门控，UI 隐藏没买的模块。
 *
 * 边界：签发在 `license-tool`（持私钥），这里**只拷贝已签好的 license**，不跨界签名。
 * 未设 `OD_PACK_CUSTOMER` = 不内嵌 = 无 license = 全功能（开发/超集包，行为不变）。
 * DMG 交付给客户时另走 `workbuild license import license.json`（见 customers/README.md）。
 */
/** 解析 OD_PACK_CUSTOMER 命中的客户 license 原文(未设/未命中→null,命中但没签发→抛)。 */
async function resolveCustomerLicense(config: ToolPackConfig): Promise<{ customer: string; raw: string } | null> {
  const want = (process.env.OD_PACK_CUSTOMER ?? "").trim();
  if (!want || config.portable) return null;

  const customersDir = join(config.workspaceRoot, "customers");
  let dirNames: string[];
  try {
    dirNames = (await readdir(customersDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    throw new Error(`OD_PACK_CUSTOMER=${want}，但找不到 customers/ 目录（${customersDir}）`);
  }

  const wantLc = want.toLowerCase();
  let matchDir: string | undefined;
  let matchManifest: CustomerManifest | undefined;
  for (const name of dirNames) {
    let manifest: CustomerManifest;
    try {
      manifest = JSON.parse(await readFile(join(customersDir, name, "manifest.json"), "utf8")) as CustomerManifest;
    } catch {
      continue; // 没 manifest 的目录跳过
    }
    const keys = [manifest.slug, manifest.customer, name, ...(manifest.aliases ?? [])]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => s.toLowerCase());
    if (keys.includes(wantLc)) {
      matchDir = name;
      matchManifest = manifest;
      break;
    }
  }
  if (!matchDir || !matchManifest) {
    throw new Error(
      `OD_PACK_CUSTOMER=${want} 没匹配到任何客户——检查 customers/*/manifest.json 的 slug/aliases`,
    );
  }

  const licensePath = join(customersDir, matchDir, "license.json");
  let licenseRaw: string;
  try {
    licenseRaw = await readFile(licensePath, "utf8");
  } catch {
    throw new Error(
      `客户「${matchManifest.customer ?? matchDir}」还没签发 license.json——先跑 license-tool make（见 customers/README.md）`,
    );
  }

  return { customer: matchManifest.customer ?? matchDir, raw: licenseRaw };
}

export async function seedPackagedLicense(config: ToolPackConfig): Promise<void> {
  const lic = await resolveCustomerLicense(config);
  if (!lic) return;
  const target = join(config.roots.runtime.namespaceRoot, "data", "license.json");
  await mkdir(dirname(target), { recursive: true });
  // license 不是用户数据：每次打包按当前客户【覆盖】(与 app-config 的合并保用户数据策略相反)。
  await writeFile(target, lic.raw, "utf8");
  process.stderr.write(`[tools-pack mac] seeded license customer=${lic.customer} → ${target}\n`);
}

/** 把客户 license 嵌进 dmg 资源(<resourceRoot>/customer-license.json)——daemon 首启发现
 *  dataDir 没有 license 时自动安装,交付自包含零操作(2026-07-17:此前只种本机测试
 *  runtime,dmg 不带 license,客户装机=无license=全功能解锁,门控形同虚设)。 */
export async function bundleCustomerLicense(config: ToolPackConfig, resourceRoot: string): Promise<void> {
  const lic = await resolveCustomerLicense(config);
  if (!lic) return;
  const target = join(resourceRoot, "customer-license.json");
  await writeFile(target, lic.raw, "utf8");
  process.stderr.write(`[tools-pack mac] bundled license customer=${lic.customer} → dmg 资源\n`);
}
