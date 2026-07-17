@AGENTS.md

# 本分支定制：油炸老总客户版（video-auto-油炸老总-爆款引擎）

本机同时安装多个客户的定制开发包，**打包身份绝不能混淆**。本分支的身份约定如下，优先级高于上游/其他分支的任何品牌字样。

## 打包与品牌身份（唯一正确值：social-auto）

- **产品名 = 打包名 = 品牌名 = `social-auto`**。不得改回或写成 WorkBuild、Multimedia、爆创、Open Design（上游名）。界面文案中的品牌位也统一用 social-auto。
- 打包身份的单一来源：
  - `tools/pack/src/mac/constants.ts` 与 `tools/pack/src/win/constants.ts` 的 `PRODUCT_NAME = "social-auto"`；Linux 在 `tools/pack/src/linux.ts`（`PRODUCT_NAME` / `APP_IMAGE_PRODUCT_NAME`）。
  - appId：`com.social-auto.desktop`（beta/nightly/preview 通道自动带后缀，见 `tools/pack/src/mac/identity.ts`）。
  - 开机自启 LaunchAgent：`com.social-auto.autostart`（apps/daemon/src/server.ts）。
- 产物形态：mac 装出来是 `social-auto.app`（可执行文件 `social-auto`），安装器标题 `social-auto-<namespace>`；CLI 交付包 `social-auto-cli`（bin 命令 `social-auto`，`od` 别名保留，见 `apps/daemon/scripts/build-cli-package.ts`）。
- 引擎备份产物名：`social-auto备份-<时间戳>.tar.gz`（bakuan-engine/scripts/ops.py）。

## 打包命令（沿用 AGENTS.md 的 tools-pack 控制面）

```bash
pnpm tools-pack mac build --to all     # 构建 mac 安装产物
pnpm tools-pack mac install            # 本机安装验证
pnpm tools-pack mac cleanup            # 清理本机安装
pnpm tools-pack win build --to nsis
pnpm tools-pack linux build --to appimage
```

打包前先过门禁：`pnpm guard && pnpm typecheck`。打包资源准备（Python 运行时/ffmpeg/wheels）见 `tools/pack/src/resources.ts`；本分支**不含 lark-cli**（飞书已整体移除）。

## 本分支其它红线

- **飞书功能已全链路移除**（daemon 数据中心 API、web 飞书 UI、引擎 src/feishu、lark-cli 打包）。不要再引入飞书/lark 依赖；引擎持久化为纯本地，选题走 radar/TikHub。
- `~/.workbuild` 是许可签名**私钥目录**，跨客户分支共用，**不许改名/迁移**（apps/daemon/scripts/license-tool.ts）。
- `customers/` 是各客户历史交付文档，其中的旧品牌字样属于历史记录，不参与品牌替换。
- 波兰语翻译里的 `'Multimedia'`/`'Nowe multimedia'`（apps/web/src/i18n/locales/pl.ts）和意大利语 `multimediali` 是自然语言词汇，不是品牌残留，不要"清理"。
