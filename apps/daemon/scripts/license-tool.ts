// 运营方签发工具(2026-07-11 定制版授权机制)。只在运营方本机运行——
// 私钥(~/.workbuild/license-signing.key)绝不进仓库、绝不进产品包。
//
//   pnpm --filter @open-design/daemon license-tool keygen
//   pnpm --filter @open-design/daemon license-tool make \
//     --customer "翟总·中国维澳" --features article.wechat-mp,kb,cap.ai \
//     --expires 2026-12-31 [--edition custom] [--out license.json]
//   pnpm --filter @open-design/daemon license-tool make --customer X --preset full --expires ...
//   pnpm --filter @open-design/daemon license-tool inspect license.json
//
// 客户侧装载:`multimedia license import license.json`(或拷到数据目录重启)。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { ALL_FEATURE_IDS, isFeatureId, type FeatureId, type LicenseFile, type LicensePayload } from '@open-design/contracts';
import { verifyLicenseFile } from '../src/license.js';

const KEY_DIR = path.join(os.homedir(), '.workbuild');
const KEY_PATH = path.join(KEY_DIR, 'license-signing.key');

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.log(`用法:
  license-tool keygen                      生成签发密钥对(私钥落 ${KEY_PATH})
  license-tool make --customer "<客户名>" --expires YYYY-MM-DD \\
       (--features id1,id2,... | --preset full) [--edition custom|consumer] [--out 文件]
  license-tool inspect <license.json>      验签并打印内容

可用功能 id: ${ALL_FEATURE_IDS.join(', ')}`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'keygen') {
  if (existsSync(KEY_PATH)) {
    console.error(`已存在私钥,拒绝覆盖: ${KEY_PATH}\n(覆盖会让所有已签发的客户授权失效——真要换钥先手动备份删除)`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`私钥已写入: ${KEY_PATH}`);
  console.log('⚠ 立刻备份这个文件(丢了就无法给老客户续签)。');
  console.log(`公钥(粘进 apps/daemon/src/license.ts 的 LICENSE_PUBLIC_KEY_SPKI_B64):`);
  console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  process.exit(0);
}

if (cmd === 'make') {
  const customer = flagValue(rest, 'customer');
  const expires = flagValue(rest, 'expires');
  const preset = flagValue(rest, 'preset');
  const featuresRaw = flagValue(rest, 'features');
  const edition = (flagValue(rest, 'edition') ?? 'custom') as LicensePayload['edition'];
  if (!customer || !expires || (!featuresRaw && preset !== 'full')) usage();
  if (edition !== 'custom' && edition !== 'consumer') usage();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    console.error('--expires 格式: YYYY-MM-DD');
    process.exit(2);
  }
  const features: FeatureId[] =
    preset === 'full'
      ? [...ALL_FEATURE_IDS]
      : (featuresRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
          if (!isFeatureId(s)) {
            console.error(`未知功能 id: ${s}\n可用: ${ALL_FEATURE_IDS.join(', ')}`);
            process.exit(2);
          }
          return s;
        });
  if (features.length === 0) {
    console.error('功能列表为空');
    process.exit(2);
  }
  if (!existsSync(KEY_PATH)) {
    console.error(`找不到签发私钥: ${KEY_PATH}(先跑 keygen,或从备份恢复)`);
    process.exit(1);
  }
  const payload: LicensePayload = {
    v: 1,
    edition,
    customer,
    features,
    issuedAt: new Date().toISOString().slice(0, 10),
    // 到期日按当天 23:59:59 本地化意图,统一写成当日结束的 UTC 前一刻即可;
    // 简化为日期串,验证端 Date.parse 到当天零点——签发时+1 天更符合直觉。
    expiresAt: expires,
  };
  const privateKey = createPrivateKey(readFileSync(KEY_PATH, 'utf8'));
  const signature = cryptoSign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64');
  const file: LicenseFile = { payload, signature };
  const out = flagValue(rest, 'out') ?? `license-${customer.replace(/[^\w一-龥-]+/g, '_')}.json`;
  writeFileSync(out, JSON.stringify(file, null, 2) + '\n', 'utf8');
  console.log(`已签发 → ${out}`);
  console.log(`客户: ${customer} · ${edition} · 到期 ${expires}`);
  console.log(`功能(${features.length}): ${features.join(', ')}`);
  console.log(`交付: 发给客户后执行 multimedia license import ${path.basename(out)}`);
  process.exit(0);
}

if (cmd === 'inspect') {
  const file = rest.find((a) => !a.startsWith('-'));
  if (!file) usage();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const result = verifyLicenseFile(raw);
  if (!result.ok) {
    console.error(`✗ 验签失败: ${result.reason}`);
    process.exit(1);
  }
  const p = result.payload;
  const expired = Date.now() > Date.parse(p.expiresAt);
  console.log(`✓ 签名有效${expired ? '(但已过期)' : ''}`);
  console.log(`客户: ${p.customer} · ${p.edition} · 签发 ${p.issuedAt} · 到期 ${p.expiresAt}`);
  console.log(`功能(${p.features.length}): ${p.features.join(', ')}`);
  process.exit(expired ? 1 : 0);
}

usage();
