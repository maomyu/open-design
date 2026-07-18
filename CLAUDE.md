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

## Windows 打包机(局域网 192.168.1.11,仓库 E:\code\baochuang\open-design)

- win 链路 2026-07-18 已补齐(commit a5fb3fc8/ba900ffe/3873bafe):provision win32 平台化、GBK 修复、win license 内嵌。构建命令:`pnpm tools-pack win build --to nsis --namespace baochuang --portable`(交付必须 `--portable`,否则本机路径烙进安装包;交付前设 `OD_PACK_CUSTOMER=煜之禾`(ssh 下用 ASCII 别名 `yuzhihe`)且 customers/ 下要有已签 license.json——**签名私钥只在 mac,永远不复制到 win**,只传签好的 license.json)。
- **交付 namespace 已拍板(2026-07-18 用户定):win 客户包就用 `baochuang`,不改 default**——多客户装同一台机器时快捷方式/卸载项(WorkBuild baochuang)天然可区分;注册表卸载键随 namespace 定死,后续升级包必须沿用同 namespace。未来其他客户包各用自己的 namespace(slug)。
- win vendor 五件套(python-runtime/wheels/ffmpeg/lark-cli/requirements-runtime)是 win 机本地产物,重生成方法见 `tools/pack/VENDOR.win.md`;出厂 .env 模板是 tracked 的 `bakuan-engine/.env.factory`(密钥全空),两台打包机共用,别再手搓。
- win 机 push GitHub 会卡 HTTPS 凭据(ssh 会话弹不出登录框):**由 mac 收提交再推**——win 机 `git bundle create C:\Users\Administrator\wip.bundle <base>..HEAD`,mac `scp` 回来 `git fetch <bundle> HEAD`,验完 typecheck 后 mac 推两跳。直接 `git fetch ssh://.../E:/...` 会因 win 默认 PATH 无 git-upload-pack 而失败。
- ssh 远端 shell 对 `chcp`/`>nul` 组合会炸("系统找不到指定的路径"),带中文的 git commit 一律 `scp` 消息文件 + `git commit -F` 提交,提交后回读 `git log --format=%s -1` 校验没变 mojibake。
- win 机 od CLI 钉死 socket 用命名管道:`OD_SIDECAR_IPC_PATH=\\.\pipe\open-design-baochuang-daemon`。数据目录在 `%APPDATA%\WorkBuild\namespaces\baochuang\data\`(portable 语义)。
