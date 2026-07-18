// 客户装机用的瘦 CLI npm 包构建器(2026-07-10 客户交付模型:客户机装
// Node/npm+智能体+桌面端,智能体经 CLI 驱动创作台)。
//
// 产出 apps/daemon/dist-cli/workbuild-cli-<版本>.tgz:
//  - cli.mjs:esbuild 把 src/cli.ts 连依赖 bundle 成单文件(纯 HTTP/IPC
//    客户端;daemon 服务端代码是懒加载,客户端命令不会碰到原生依赖)
//  - bin 双命令名:workbuild(客户看产品名)与 od(手册/内部一致)
//  - daemon 地址零配置:CLI 内置固定 IPC base 扫描(见 src/daemon-url.ts),
//    装完即用,前提是桌面端(或 dev daemon)在跑
//
// 客户装机:npm install -g ./workbuild-cli-<版本>.tgz(或推私有 registry)。
// 运行:pnpm --filter @open-design/daemon cli-pack
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(daemonRoot, 'dist-cli');
const pkgDir = path.join(outRoot, 'pkg');

const daemonPkg = JSON.parse(readFileSync(path.join(daemonRoot, 'package.json'), 'utf8')) as {
  version: string;
};

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

await build({
  entryPoints: [path.join(daemonRoot, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: path.join(pkgDir, 'cli.mjs'),
  logLevel: 'warning',
  // ESM bundle 必配:esbuild 把 CJS 依赖里的 require(Node 内置模块)转成 __require 垫片,
  // 垫片在 ESM 里找不到全局 require 就 throw "Dynamic require of node:xxx is not supported"。
  // 客户端命令(help/monitor/studio)走纯 fetch 碰不到;懒加载 daemon 服务端代码的路径必炸
  // (2026-07-19 客户机实炸)。banner 用 createRequire 定义顶层 require,垫片检查直接命中。
  // 导入名带前缀,避开 bundle 内依赖自己 hoist 的 createRequire 同名声明。
  banner: {
    js: 'import { createRequire as __wbCliCreateRequire } from "node:module"; const require = __wbCliCreateRequire(import.meta.url);',
  },
  // 瘦包标记:cli.ts 据此把「自起 daemon」的意图改成人话引导(bundle 里没有服务端的
  // 原生/wasm 依赖,自起必死;daemon 由爆创桌面端提供)。
  define: { 'process.env.WB_THIN_CLI': '"1"' },
});

writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify(
    {
      name: 'workbuild-cli',
      version: daemonPkg.version,
      description:
        'WorkBuild 媒体创作台命令行(选题/AI 写作/配图/排版/发布全流水线;供智能体与终端使用,需 WorkBuild 桌面端或 daemon 在本机运行)',
      license: 'Apache-2.0',
      type: 'module',
      bin: { workbuild: './cli.mjs', od: './cli.mjs' },
      engines: { node: '>=18.17' },
      files: ['cli.mjs', 'README.md'],
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  path.join(pkgDir, 'README.md'),
  `# WorkBuild CLI

媒体创作台的命令行入口(与桌面端同一套后端能力),供智能体(Claude Code 等)与终端驱动
选题 → AI 写作 → 配图 → 排版 → 发布 全流水线。

## 安装

\`\`\`bash
npm install -g ./workbuild-cli-<版本>.tgz
\`\`\`

前提:本机安装并运行 WorkBuild 桌面端(CLI 自动发现其后台服务,零配置)。

## 快速验证

\`\`\`bash
workbuild studio --help          # 全部命令(od 是等价别名)
workbuild studio articles        # 公众号文章列表
\`\`\`

## 常用

\`\`\`bash
workbuild studio ai write <文章id> --words 1500-2000   # AI 写稿(等待完成)
workbuild studio publish <文章id> --account <账号id>   # 公众号 → 草稿箱
workbuild studio handoff <文章id> --target weibo --auto # 微博直发(需桌面端)
\`\`\`

完整手册见仓库 docs/media-studio-cli.md。
`,
);

execFileSync('npm', ['pack', '--pack-destination', outRoot], { cwd: pkgDir, stdio: 'inherit' });
const tarball = path.join(outRoot, `workbuild-cli-${daemonPkg.version}.tgz`);
console.log(`\n[cli-pack] 客户装机包: ${tarball}`);
console.log(`[cli-pack] 装机: npm install -g ${tarball}`);
