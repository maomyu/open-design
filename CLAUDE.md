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

## 打包方式（mac，直接更新客户已装包）

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH   # 本机默认 Node 18，先切 v24.16.0
pnpm --filter @open-design/tools-pack build           # 若改过 tools/pack 源码
pnpm tools-pack mac build --to all                    # 保持 WorkBuild 身份，unsigned
```

产物（`.tmp/tools-pack/out/mac/namespaces/default/`）：
- `dmg/WorkBuild-default.dmg` — 发客户拖装覆盖旧版（不看版本，最稳）
- `zip/WorkBuild-default.zip` + `zip/latest-mac.yml` — 自动更新用（版本要 > 客户已装才触发，
  同版号不会更新；要走自动更新就先 bump `apps/desktop`+`apps/packaged`+根 `package.json` 版本）

装上并打开验证：`pnpm tools-pack mac install` → `pnpm tools-pack mac start` →
`pnpm tools-pack mac inspect screenshot --path /tmp/x.png`；停：`pnpm tools-pack mac stop`。

- 短视频 Python 引擎（bakuan-engine）默认**不打进包**（缺 `tools/pack/vendor/{python-runtime,ffmpeg,wheels}`
  时打包器自动跳过）。本客户只用 文章/小红书/知识库，不依赖引擎，够用。
- 未签名（`identity=null`）：客户首开可能要右键→打开过 Gatekeeper。要签名/公证配证书跑 `--signed`。

## 本客户功能范围

文章（公众号/知乎/微博）+ 小红书（图文笔记）+ 企业知识库。**飞书数据中心已彻底移除**
（那是配合爆款引擎/短视频的，本客户不用）。短视频台代码在、靠授权开关控制显隐。
