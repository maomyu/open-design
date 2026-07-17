@AGENTS.md

# 本分支打包与品牌(重要,别搞混包)

本机装有多个客户定制开发包,认准:**本分支(video-auto-煜之禾-爆款引擎)打出来的包名/品牌名都是「爆创」**。

- 产物 app:`WorkBuild.app`,窗口标题/品牌名「爆创」(`tools/pack/src/mac/constants.ts` 的 `PRODUCT_NAME = "WorkBuild"`)。**不是** `Open Design Beta.app`——那是上游命名,本机可能同时装着其他客户的包,操作前先确认目标是爆创。
- 进程名是 `WorkBuild`,但**其他客户的检出也叫 WorkBuild**——清场必须按本仓库路径限定:`pkill -9 -f "自媒体营销/.tmp/tools-pack.*WorkBuild"`,验证用 `pgrep -f "自媒体营销/.tmp/tools-pack.*WorkBuild" | wc -l` 为 0 才准 start(**别用 `ps aux | grep 中文`**——ps 会把非 ASCII 转义成 `M-e...`,中文 grep 永远打空;pkill/pgrep 吃原始字节,中文可靠)。**严禁裸 `pkill -f WorkBuild`**(会误杀其他检出正在跑的打包进程 7za/ditto/dmgbuild 和 app);`pkill -f "Open Design"` 则根本打不中。残留旧实例会霸住 IPC socket,新 daemon EADDRINUSE 秒死。
- **IPC socket 是跨检出全局共享的**:`/tmp/open-design/ipc/default/daemon.sock` 按 namespace(default)寻址,不分仓库——如果另一个客户项目的 app 同时在跑,两个 app 会抢同一个 socket(EADDRINUSE/互相掐)。同时开发多个客户包时,同一时刻只让一个包的 app 活着,或者给本仓库跑非 default namespace。也不要 `rm -rf /tmp/open-design/ipc/default`——可能删掉的是别的项目正用着的 socket。
- 客户定制打包(煜之禾/鱼老师):`OD_PACK_CUSTOMER=煜之禾 pnpm tools-pack mac build --to dmg`。打包前把 `bakuan-engine/.env` 的 `FEISHU_BITABLE_APP_TOKEN` 洗成出厂空白(先 `cp bakuan-engine/.env /tmp/env.dev-backup` 备份),打完**立刻恢复** dev token。license 由 `bundleCustomerLicense` 自动打进 dmg 资源,首启自动安装。
- 打包纪律:build 输出重定向到文件并等 `dmgBytes` 出现才算完;顺序 pkill → install → start;若中途杀过打包进程,`rm -rf .tmp/tools-pack/cache/locks/global.lock`(它是**目录**,rm -f 删不掉)。
- 装包后首启会触发引擎 provision/resync(可能持续几十秒),等 `.tmp/tools-pack/runtime/mac/namespaces/default/data/bakuan-engine/.od-engine-src-stamp` 更新后再验证 `.env`/引擎状态,别在 resync 完成前下结论。
- 本机测试机需要 dev 飞书 token:客户包首装会带出厂空白 `.env`,装完后把 token 写回 runtime `.env`(resync 已改为保留 runtime 已有键,升级不再抹掉)。
