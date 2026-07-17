@AGENTS.md

# 本分支打包与品牌(重要,别搞混包)

本机装有多个客户定制开发包,认准:**本分支(video-auto-煜之禾-爆款引擎)打出来的包名/品牌名都是「爆创」**,产物 `WorkBuild.app`(`tools/pack/src/mac/constants.ts` 的 `PRODUCT_NAME`),**不是** `Open Design Beta.app`。

## 运行时隔离(2026-07-17 定死,必须遵守)

本机同时开发调试 3 个客户包,`/tmp/open-design/ipc/` 下同时存在多个 namespace(已见:`default`、`social-auto`、`workbuild`)。**本分支独占 namespace `baochuang`**,数据目录/IPC socket/端口/生命周期全部独立:

- **所有 tools-pack 生命周期命令必须带 `--namespace baochuang`**:build/install/start/stop/logs/inspect。本地安装的 app 是 `.tmp/tools-pack/out/mac/namespaces/baochuang/install/Applications/WorkBuild.baochuang.app`,运行时数据在 `.tmp/tools-pack/runtime/mac/namespaces/baochuang/data/`。
- **所有 od CLI 调用必须钉死 socket**:`OD_SIDECAR_IPC_PATH=/tmp/open-design/ipc/baochuang/daemon.sock node apps/daemon/dist/cli.js ...`。钉死失败 CLI 会硬报错退出(`daemon-url.ts` 已改:显式钉死绝不回退跨 namespace 扫描——回退会连到**别的客户的 daemon**,串库比连不上危险得多)。
- **停 app 用 scoped stop**:`pnpm tools-pack mac stop --namespace baochuang`(按 stamp 精确停,不碰别的检出)。万不得已才 pkill,必须按 stamp 限定:`pkill -9 -f "od-stamp-namespace=baochuang"`。**严禁**裸 `pkill -f WorkBuild`(会误杀其他客户检出的 app 和正在跑的打包进程 7za/ditto/dmgbuild);`pkill -f "Open Design"` 根本打不中。
- **`/tmp/open-design/ipc/` 下只准动 `baochuang/`**,其他 namespace(default/social-auto/workbuild/…)是别的客户包的,连 `rm` stale socket 都不行。本仓库的 default namespace 已退役(旧数据留在 `namespaces/default/data` 作备份,不要在它上面起 app)。
- 进程验证用 pgrep(**别用 `ps aux | grep 中文`**——ps 把非 ASCII 转义成 `M-e...`,中文 grep 永远打空;pkill/pgrep 吃原始字节,中文可靠):`pgrep -f "od-stamp-namespace=baochuang" | wc -l`。

## 客户交付包 vs 本机测试包

- **交付客户**:`OD_PACK_CUSTOMER=煜之禾 pnpm tools-pack mac build --to dmg`,打包前把 `bakuan-engine/.env` 的 `FEISHU_BITABLE_APP_TOKEN` 洗成出厂空白(先 `cp bakuan-engine/.env /tmp/env.dev-backup` 备份),打完**立刻恢复**。license 由 `bundleCustomerLicense` 打进 dmg 资源,客户机首启自动安装。
- **本机测试**:`OD_PACK_CUSTOMER=煜之禾 pnpm tools-pack mac build --to dmg --namespace baochuang`,**不洗 token**(测试机要连 dev 飞书库)。
- 打包纪律:build 输出重定向到文件并等 `dmgBytes` 出现才算完;若中途杀过打包进程,`rm -rf .tmp/tools-pack/cache/locks/global.lock`(它是**目录**,rm -f 删不掉)。
- 装包后首启会触发引擎 provision/resync(venv 重建可达几分钟),等 `.tmp/tools-pack/runtime/mac/namespaces/baochuang/data/bakuan-engine/.od-engine-src-stamp` 更新后再验证,别在 resync 完成前下结论。resync 对 `.env` 是**合并语义**(runtime 已有键保留,只追加新键)——客户升级 app 不会丢「连接飞书」写入的 token。
