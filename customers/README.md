# 客户定制打包中心

> 单一代码库（本仓库）= **最全的系统**。每个客户拿到的安装包，是从这个超集里
> **按功能定制裁剪**出来的——靠一份**签名 license** 控制他能看到/用到哪些功能。
> 本目录就是每个客户的「打包清单 + 产品档案」。

## 一句话机制

功能项在 [`packages/contracts/src/api/license.ts`](../packages/contracts/src/api/license.ts) 统一定义 →
每个客户在本目录有一个文件夹（`manifest.json` 声明功能集）→ 打包时读该客户的
manifest，用运营方私钥**签发一份 license.json 内嵌进安装包** → 客户端 daemon 按
license 拦截未授权 API、web 隐藏没买的模块。**无 license = 全功能解锁**（开发/CI 不受影响）。

- **强制点**：daemon `licenseGuard`（[`apps/daemon/src/license.ts`](../apps/daemon/src/license.ts)）——UI 隐藏只是体验层，CLI/智能体走 API 一样被拦。
- **签发工具**：[`apps/daemon/scripts/license-tool.ts`](../apps/daemon/scripts/license-tool.ts)（私钥在运营方本机 `~/.workbuild/license-signing.key`，绝不进仓库）。
- **到期语义**：锁功能、留数据（写操作 403，读端点放行）。

## 每个客户文件夹放什么

```
customers/<客户>/
  manifest.json    # 机器读:功能清单/版本/到期/边界——驱动打包与 license 签发
  README.md        # 人读:产品文档、原始需求、功能列表、进度、备注
```

### manifest.json 字段

| 字段 | 说明 |
|---|---|
| `slug` | ASCII 短名，`--customer` 打包时用（如 `yuzhihe`） |
| `customer` | license 里展示的客户名（如 `煜之禾·鱼老师`） |
| `aliases` | 别名，命令里说「打包鱼老师」也能匹配 |
| `edition` | `custom`（定制版，未授权功能不渲染）/ `consumer`（预留） |
| `expires` | 到期日 `YYYY-MM-DD` |
| `appName` | 安装包应用名（品牌） |
| `features` | 功能 id 数组（见下方全集），**打包裁剪的唯一依据** |
| `status` | 进度：`in-development` / `shipped` / `pending-requirements` |
| `sourceBranch` | 历史来源分支（迁移期参考，最终都归并到超集） |
| `notes` | 一句话定位 |

## 功能 id 全集

以 [`license.ts`](../packages/contracts/src/api/license.ts) 的 `ALL_FEATURE_IDS` 为准：

- **文章**：`article.wechat-mp`(公众号) `article.zhihu`(知乎) `article.weibo`(微博)
- **短视频**：`sv.douyin` `sv.kuaishou` `sv.shipinhao`(视频号) `sv.bilibili` `sv.xiaohongshu`
- **图文笔记**：`note.xiaohongshu`
- **数据中心**：`integrations`（飞书多维表格数据中心）
- **知识库**：`kb.personal`(个人自媒体库) `kb.enterprise`(企业知识库) — 两套分类不同，按 license 分别渲染
- **横切能力**：`cap.ai`(AI 写作/仿写) `cap.image`(配图/封面) `cap.tts`(配音) `cap.video`(成片) `cap.handoff`(一键存草稿) `cap.publish`(发布)

## 现有客户

| 客户 | slug | 定位 | 知识库 | 进度 |
|---|---|---|---|---|
| 煜之禾·鱼老师 | `yuzhihe` | 个人自媒体·短视频爆款 + 公众号 | 个人库 | 开发中 |
| 中国维澳·翟总 | `zhongguoweiao` | 企业·公众号/微博/知乎文章 | 企业库 | 迁移中 |
| 油炸老总 | `youzha` | 特殊（需求待补） | 待定 | 待需求 |

## 怎么按客户打包

分两步:①签发该客户 license(读 manifest,需运营方私钥) ②打包时用 `OD_PACK_CUSTOMER` 内嵌。

```bash
# 1) 签发 license.json 到客户目录(customer/features/expires 都取自 manifest)
#    注意 --out 用绝对路径(pnpm --filter 会切到 apps/daemon 目录)
ROOT=$(pwd); DIR="customers/煜之禾-鱼老师"; MF="$ROOT/$DIR/manifest.json"
pnpm --filter @open-design/daemon license-tool make \
  --customer "$(python3 -c "import json;print(json.load(open('$MF'))['customer'])")" \
  --features "$(python3 -c "import json;print(','.join(json.load(open('$MF'))['features']))")" \
  --expires  "$(python3 -c "import json;print(json.load(open('$MF'))['expires'])")" \
  --out "$ROOT/$DIR/license.json"

# 2) 打包:OD_PACK_CUSTOMER 指定客户(slug 或别名),tools-pack 的 seed-license
#    阶段会把该客户已签发的 license.json 内嵌进运行时数据目录
OD_PACK_CUSTOMER=翟总    pnpm tools-pack mac build --to dmg   # → 打翟总的包(只文章+企业库)
OD_PACK_CUSTOMER=yuzhihe pnpm tools-pack mac build --to dmg   # → 打鱼老师的包(短视频全平台+个人库)
# 不设 OD_PACK_CUSTOMER = 无 license = 全功能超集包(开发/内部用)
```

- 匹配:`OD_PACK_CUSTOMER` 比对每个 manifest 的 `slug` / `customer` / `aliases` / 文件夹名(大小写不敏感),命中即拷该目录的 `license.json`。没签发会**直接报错**,不会静默出全功能包。
- 交付客户:把签好的 `license.json` 给客户,客户侧 `workbuild license import license.json`(或拷进数据目录重启)。
- 实现:[`tools/pack/src/mac/license-seed.ts`](../tools/pack/src/mac/license-seed.ts),接在 `seed-app-config` 之后。

打包前**务必先读对应客户的 manifest + README**,确认功能集与进度——不同客户功能不同,打错包=客户看到没买的功能或缺功能。
