import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

type CustomerManifest = { customer?: string; slug?: string; aliases?: string[] };

export interface ResolvedCustomerLicense {
  /** customers/ 下的目录名。 */
  dir: string;
  /** license 里展示的客户名（manifest.customer，缺省回落目录名）。 */
  customer: string;
  /** 已签发的 license.json 原文（原样搬运，绝不在这里改动或签名）。 */
  raw: string;
}

/**
 * 按 `OD_PACK_CUSTOMER` 解析出该客户【已签发】的 license.json。
 *
 * 从 `mac/license-seed.ts` 抽出来共享：原先这套匹配逻辑只长在 mac 打包路径上，Windows
 * 打包完全没有客户裁剪这一步——出的永远是全功能超集包（2026-07-26 实测:客户机上能看到
 * 公众号/抖音/快手/B站/视频号这些合同外平台）。
 *
 * 边界：签发在 `license-tool`（持私钥），这里只读取已签好的文件，不跨界签名。
 * 未设 `OD_PACK_CUSTOMER` 返回 null = 不裁剪 = 全功能超集包（开发/内部用，行为不变）。
 * 匹配不到客户 / 客户还没签发 license 都【直接抛错】——绝不静默出一个全功能包发给客户。
 */
export async function resolveCustomerLicense(workspaceRoot: string): Promise<ResolvedCustomerLicense | null> {
  const want = (process.env.OD_PACK_CUSTOMER ?? "").trim();
  if (!want) return null;

  const customersDir = join(workspaceRoot, "customers");
  let dirNames: string[];
  try {
    dirNames = (await readdir(customersDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    throw new Error(`OD_PACK_CUSTOMER=${want}，但找不到 customers/ 目录（${customersDir}）`);
  }

  const wantLc = want.toLowerCase();
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
    if (!keys.includes(wantLc)) continue;

    const customer = manifest.customer ?? name;
    let raw: string;
    try {
      raw = await readFile(join(customersDir, name, "license.json"), "utf8");
    } catch {
      throw new Error(
        `客户「${customer}」还没签发 license.json——先跑 license-tool make（见 customers/README.md）`,
      );
    }
    return { dir: name, customer, raw };
  }

  throw new Error(
    `OD_PACK_CUSTOMER=${want} 没匹配到任何客户——检查 customers/*/manifest.json 的 slug/aliases`,
  );
}
