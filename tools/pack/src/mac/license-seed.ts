import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolPackConfig } from "../config.js";
import { resolveCustomerLicense } from "../customer-license.js";

/**
 * 把客户 license 播进【本地打包运行时数据目录】,给 `tools-pack mac install` 之后的本机
 * 验证用——这样本机装出来的包也按合同裁剪,能当场看出功能范围对不对。
 *
 * 注意这跟【内嵌进安装包】是两回事:发给客户的那份走 `copyCustomerLicense()`
 * (tools/pack/src/resources.ts),写进资源树、daemon 首启动播种到用户数据目录。
 * 两处共用 `resolveCustomerLicense` 的客户匹配与"未签发就报错"边界。
 */
export async function seedPackagedLicense(config: ToolPackConfig): Promise<void> {
  if (config.portable) return;
  const resolved = await resolveCustomerLicense(config.workspaceRoot);
  if (!resolved) return; // 未设 OD_PACK_CUSTOMER = 无 license = 全功能(开发/超集包)

  const target = join(config.roots.runtime.namespaceRoot, "data", "license.json");
  await mkdir(dirname(target), { recursive: true });
  // license 不是用户数据：每次打包按当前客户【覆盖】(与 app-config 的合并保用户数据策略相反)。
  await writeFile(target, resolved.raw, "utf8");
  process.stderr.write(
    `[tools-pack mac] seeded license customer=${resolved.customer} → ${target}\n`,
  );
}
