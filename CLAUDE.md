@AGENTS.md

# 客户定制构建 — 本分支 = 翟总 / 中国维澳（品牌 WorkBuild）

> 本机同时装多个客户定制包，务必别串品牌。**本分支（`video-auto-6.1-翟总`，客户
> 中国维澳·翟红）的产品名 / 品牌 / 包名一律是 `WorkBuild`。** 「爆创」是**另一个
> 客户（煜之禾·鱼老师，爆款引擎那套）的产品名**，本分支任何地方都不该出现「爆创」。

## 品牌铁律（打包前必查）

- 应用内品牌 = `WorkBuild`：i18n key `app.brand` 在全部 18 个 locale 里都必须是
  `WorkBuild`（侧栏左上角 wordmark 就读它）；首页 hero、各处文案也是 WorkBuild。
- macOS 身份 = `WorkBuild`：`tools/pack/src/mac/constants.ts` 的 `PRODUCT_NAME="WorkBuild"`、
  appId `com.workbuild.desktop`、bundle `WorkBuild.app`。**绝不改这些**——客户已装的是
  WorkBuild，改了身份就更新不上他那台机器。
- **合并「爆款引擎」分支后必做**：`git grep -n 爆创 -- 'apps/**' 'packages/**' 'bakuan-engine/**'`
  应为空。爆款引擎分支把 WorkBuild 全局改名成了「爆创」，每次并进来都要再扫回：
  `git grep -l 爆创 -- 'apps/**' 'packages/**' 'bakuan-engine/**' | xargs sed -i '' 's/爆创/WorkBuild/g'`
  （只改中文显示名「爆创」；小写内部标识 `baochuang`——分区/profile 目录名——不要动，
  改了会破坏登录态/数据兼容。）

## 运行时隔离铁律（本机同时开发调试多个客户包，绝不能串！）

**本分支专属命名空间 = `workbuild`。所有 tools-pack 生命周期命令必须带 `--namespace workbuild`，
一个都不能漏。** 命名空间决定：数据目录、IPC socket、`stop` 杀哪些进程——漏带 `--namespace`
就落到默认 `default`，会和别的客户/别的实例串（数据混、误杀别人进程）。

- 本机其它客户命名空间（**绝不碰**）：`baochuang`=煜之禾·鱼老师(爆创)、`social-auto`=另一个客户。
  查现有命名空间：`ls /tmp/open-design/ipc/`。
- 隔离维度（`--namespace workbuild` 一并带来，无需额外配置）：
  - 数据目录：`.tmp/tools-pack/runtime/mac/namespaces/workbuild/`（daemon SQLite/账号/cookie 全在这，与别的客户物理分开）
  - IPC socket：`/tmp/open-design/ipc/workbuild/{daemon,web}.sock`
  - 端口：打包版动态选空闲端口（transient，天然不撞）
  - macOS userData：`~/Library/Application Support/WorkBuild`（按产品名隔离，只此客户用 WorkBuild）
- **命令只作用于本命名空间**：`stop --namespace workbuild` 只杀 workbuild 进程，不动 baochuang/social-auto
  （已实测：停 default 时 baochuang 4 进程原封不动）。**永远别跑不带 `--namespace` 的裸命令。**

## 双包交付（2026-07-17 翟总拍板：给客户装两个软件，两次交付）

**同一分支打两个身份不同的包，客户机并存安装、互不冲突。功能差异不靠改代码，
靠打包时烤进包资源的已签发 license（`OD_PACK_LICENSE_FILE`）——daemon 数据目录无
运行时 license 时回落读包内 `Resources/open-design/license.json`，装上即生效；
后续 `workbuild license import` 可覆盖。** license/清单在 `customers/中国维澳-翟总/`
（manifest.json 记录双包 features；license-article.json / license-video.json 已签发）。

**品牌更名(2026-07-17 用户拍板)**:文章包=`weiao-article`、视频包=`weiao-video`
(维澳双产品;旧 WorkBuild 身份弃用——客户机旧 WorkBuild.app 让客户删除,装新双包)。
应用内侧栏品牌由打包时 `NEXT_PUBLIC_OD_BRAND` 注入(EntryNavRail 读它,回落 i18n)。
**⚠️ 坑(2026-07-17 实测,两层缓存都会串品牌)**:品牌是 next build 构建期内联,
而 web 产物在两层被复用——① `apps/web/out`+`.next` 增量;② tools-pack 的
standalone 内容缓存 `.tmp/tools-pack/cache/entries`(env 不进缓存 key)。换品牌
打另一个包之前必须三个都清:
`rm -rf apps/web/out apps/web/.next .tmp/tools-pack/cache/entries`
打完 grep 产物核对:`grep -rl weiao-video <namespace>/builder/mac-arm64/*.app/Contents/Resources/app/web* | head -1` 有命中才对。

| | 文章包 | 视频包 |
|---|---|---|
| 产品名/bundle | `weiao-article` / `weiao-article.app` | `weiao-video` / `weiao-video.app` |
| appId | `com.weiao.article` | `com.weiao.video` |
| 命名空间 | `workbuild` | `workbuild-video` |
| 身份 env(build 与 install/start/inspect 全要带) | `OD_PACK_PRODUCT_NAME=weiao-article OD_PACK_APP_ID=com.weiao.article NEXT_PUBLIC_OD_BRAND=weiao-article` | `OD_PACK_PRODUCT_NAME=weiao-video OD_PACK_APP_ID=com.weiao.video NEXT_PUBLIC_OD_BRAND=weiao-video` |
| license | `license-article.json` | `license-video.json` |
| 功能 | 公众号+知乎文章、企业知识库、账号(**仅发布账号,无运维块**) | 抖音/小红书(图文+视频)/快手/B站/视频号 平台入口、制作视频(口型替换)、企业知识库、账号(含运维) |

打包命令（在仓库根；改过 tools/pack 先 `pnpm --filter @open-design/tools-pack build`）：

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH   # 本机默认 Node 18，先切 v24.16.0
ROOT=$PWD

# ① 文章包（weiao-article）——身份 env 一个都不能漏
OD_PACK_PRODUCT_NAME=weiao-article OD_PACK_APP_ID=com.weiao.article \
NEXT_PUBLIC_OD_BRAND=weiao-article \
OD_PACK_LICENSE_FILE="$ROOT/customers/中国维澳-翟总/license-article.json" \
  pnpm tools-pack mac build --namespace workbuild --to all

# ② 视频包（weiao-video）——身份 env 一个都不能漏
OD_PACK_PRODUCT_NAME=weiao-video OD_PACK_APP_ID=com.weiao.video \
NEXT_PUBLIC_OD_BRAND=weiao-video \
OD_PACK_LICENSE_FILE="$ROOT/customers/中国维澳-翟总/license-video.json" \
  pnpm tools-pack mac build --namespace workbuild-video --to all
```

产物：
- 文章包 `.tmp/tools-pack/out/mac/namespaces/workbuild/`：`dmg/weiao-article-workbuild.dmg`、
  `zip/weiao-article-workbuild.zip` + `latest-mac.yml`
- 视频包 `.tmp/tools-pack/out/mac/namespaces/workbuild-video/`：`dmg/weiao-video-workbuild-video.dmg`、
  `zip/weiao-video-workbuild-video.zip` + `latest-mac.yml`
- DMG 发客户拖装覆盖旧版（不看版本，最稳）；自动更新要版本 > 客户已装（先 bump
  `apps/desktop`+`apps/packaged`+根 `package.json`）。

装上验证（**各包只用自己的 namespace，绝不混**）：
```bash
pnpm tools-pack mac install --namespace workbuild            # 文章包
pnpm tools-pack mac start   --namespace workbuild
pnpm tools-pack mac install --namespace workbuild-video      # 视频包
pnpm tools-pack mac start   --namespace workbuild-video
pnpm tools-pack mac inspect screenshot --namespace <ns> --path /tmp/x.png
pnpm tools-pack mac stop    --namespace <ns>                 # 只停对应包，不碰别人
```

- **后续按包做功能开发时**：改动先想清楚归哪个包——纯文章功能不影响视频包(反之亦然)，
  横切改动两个包都要重打+重验。授权粒度动了要重签对应 license 并同步 manifest。
- 短视频 Python 引擎(bakuan-engine)**随视频包发布**(2026-07-18 起 vendor 已备齐:
  `tools/pack/vendor/{python-runtime.tar.gz,wheels/,ffmpeg.tar.gz}`,mac arm64,git 忽略)。
  客户首启自动 provision(约 1 分钟)。视频包 DMG 因此 ~370M。vendor 丢失重建:
  python-build-standalone cpython3.12 aarch64-darwin install_only 改名 python-runtime 打 tar;
  bundled python `pip download -r bakuan-engine/requirements.txt -d wheels`;
  eugeneware/ffmpeg-static darwin-arm64 放 ffmpeg/ffmpeg 打 tar。真抓爆款还需配 TikHub key。
- 未签名（`identity=null`）：客户首开可能要右键→打开过 Gatekeeper。要签名/公证配证书跑 `--signed`。

## 本客户功能范围

**文章包**：公众号+知乎文章 + 企业知识库（无微博——2026-07-17 移除；无个人自媒体库）。
**视频包**：短视频（抖音/快手/视频号/B站/小红书）+ 小红书图文笔记 + 企业知识库。
**飞书数据中心已彻底移除**（两包都无）。爆款筛选(时间窗/播放/点赞)是短视频专属，
文章台不显示。

## 定制包种子预填(2026-07-18)

打包时 `OD_PACK_SEED_FILE=<seed.json>` 烤进包资源;daemon 每次启动幂等导入(知识按
名称查重、账号按平台+名称查重,绝不覆盖客户改动)。种子文件**含公众号 AppSecret,
放 repo 外客户目录、绝不进 git**:
- 文章包:`../seed-article.json`(翟总企业知识 6 条 + 2 个公众号账号带凭证/人设)
- 视频包:`../seed-video.json`(企业 6 条 + 水果娜旅行洗护产品 3 条)
视频包导航小红书排第一(演示优先)。build 命令在原有 env 基础上追加 OD_PACK_SEED_FILE。

## API key 纪律(2026-07-18 用户拍板)

- **客户包永不带卖方 key**:数据接口(极致了/TikHub)/火山等 key 不进 seed、不进包——
  客户用自己的 key 自己配。种子只预填 知识库+公众号账号凭证(客户自己的资产)。
- **本机开发 key 不会因打包/重装丢失**(数据目录与 app 分离);历史上"看不见"是
  key 分散配在两个 namespace。在任一包配了新 key 后跑一次
  `python3 ../sync-keys.py`(双包 media-config 互补同步,只补缺不覆盖),两包即都可见。

## 双包主体隔离铁律(2026-07-18 用户纠错,非常重要)

**两个包是两家不同公司,知识库绝不互混:**
- 文章包(weiao-article)主体 = **中国维澳·知识产权公司**——企业知识库只放维澳
  (公司介绍/资质/案例/翟姐金句),服务知产文章。种子 `../seed-article.json`。
- 视频包(weiao-video)主体 = **水果娜所属的另一家公司**(不属于中国维澳!)——
  知识库只放水果娜产品(定位组成/设计风格/卖点用户),服务小红书种草/短视频。
  种子 `../seed-video.json`。**绝不把维澳知产内容灌进视频包**(会让 AI 写种草时
  串进知产公司资质案例,内容全错;2026-07-18 已犯过一次并修正)。
- 以后新增知识/种子内容,先问「属于哪家公司主体」再决定进哪个包的种子。
