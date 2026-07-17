# 媒体创作台 CLI 手册（面向智能体）

`od studio` 是媒体创作台的完整 CLI 面：界面上能做的每一步（选题→写作→配图→排版→发布→复盘）都有对应子命令，且与界面调用**同一批 `/api/media-studio/*` 端点**——CLI 写入的产物界面实时可见，反之亦然。外部智能体（Claude Code、hermes-agent、自定义 bot）按本手册即可无界面驱动全流水线。

## 安装

**开发机（本仓库）**：`npm link`（仓库根）把 `od` 挂到全局；或直接 `node apps/daemon/dist/cli.js`。

**客户装机（npm 包）**：`pnpm --filter @open-design/daemon cli-pack` 产出
`apps/daemon/dist-cli/multimedia-cli-<版本>.tgz`（单文件瘦客户端，双命令名 `multimedia`/`od`）。
客户机器装好 Node ≥18 后一条命令：

```bash
npm install -g ./multimedia-cli-<版本>.tgz
```

装完零配置即用：CLI 自动扫描固定 IPC 端点找到本机在跑的 daemon（桌面端自带）。客户典型形态 = Node/npm + 智能体（如 Claude Code）+ Multimedia 桌面端，智能体对话与桌面端手动操作并行不冲突。

## 约定

- **daemon 定位**（依次）：`--daemon-url` → 环境变量 `OD_DAEMON_URL`（创作台 AI 任务的子进程已自动注入）→ `OD_SIDECAR_IPC_PATH` 指定的 IPC 端点 → **自动扫描** `/tmp/open-design/ipc/*/daemon.sock`（Windows 为命名管道；default 命名空间优先）→ 最后落 `http://127.0.0.1:7456`。
- **平台**：`--platform wechat-mp|zhihu|weibo|note|short-video`，缺省 `wechat-mp`。文章、选题、知识库按平台分库（知识库例外：全平台共享）。
- **机器可读**：所有查询/写入子命令支持 `--json`。
- **长文本进出**：`--body-file/--header-file/--footer-file/--file` 都接受文件路径或 `-`（stdin）。
- **退出码**：0 成功；1 业务失败；2 用法错误；3 网络/超时；4 前置条件不满足（如桌面端未连接）。
- **标题硬闸**：公众号标题 ≤64 字节（约 21 个中文字符），超长 `od studio set` 直接拒收（exit 3）——当场重拟再 set。

## 一条龙：公众号（API 直发草稿箱）

```bash
od studio find --keyword "退役军人就业" --feed radar --json      # 双信号选题雷达
od studio topic-add --title "军队文职备考误区" --angle "过来人视角" --heat 高
od studio create --title "占位" --topic "军队文职备考误区"       # 得到文章 id
od studio ai write <id> --type 深度文 --words 1500-2000          # AI 写一版(等待完成,产物自动落库)
od studio article <id>                                           # 核对成稿
od studio image <id> --desc "书桌上的备考资料,台灯暖光" --marker COVER --as-cover
od studio lint <id>                                              # 敏感词预检(警示不阻断)
od studio render <id> --skin kaiti                               # 确定性排版并保存
od studio publish <id> --account <accountId>                     # 发到公众号草稿箱(不群发)
```

`accountId` 从 `od account list --json`（账号中心）拿。公众号只发草稿箱，群发永远由人在公众号后台确认——这是产品铁律。

## 一条龙：知乎/微博（浏览器注入发布）

```bash
od studio articles --platform zhihu --json                       # 或先 import 从公众号导入:
od studio import <公众号文章id> --to zhihu                        # 复制标题/正文/封面/摘要
od studio ai revise <id> --platform zhihu --note "口语化,分段短" # 可选:平台化改写
od studio handoff <id> --target zhihu                            # 填到发送前一步(人工点发布)
od studio handoff <id> --target zhihu --auto                     # 直发(真实点击「发布」,不可撤回!)
```

`handoff` 是唯一依赖 **Multimedia 桌面应用在运行**的命令：注入引擎跑在桌面端内嵌浏览器里（登录态在桌面端分区）。桌面端没开时 create 立即失败（exit 4，报错说清楚开桌面应用再试）。进度逐行打到 stdout，终态即退出码。`--account` 不给时用账号中心该平台第一个绑定账号。

## 一条龙：小红书图文笔记

```bash
od studio create --platform note --title "占位"
od studio ai write <id> --platform note --note "亲测视角"        # 笔记文案(≤20字标题+标签落 extra)
od studio image <id> --platform note --desc "..." --marker 1     # 逐张生成图集(3:4)
od studio handoff <id> --target xiaohongshu                      # 图集 CDP 注入+文案键入,存草稿
```

## 一条龙：短视频

```bash
od studio create --platform short-video --title "占位"
od studio ai script <id> --platform short-video                  # 口播脚本
od studio tts <id> --platform short-video [--voice S_xxx]        # 配音
od studio upload-video <id> --platform short-video --file /abs/成片.mp4
od studio handoff <id> --target douyin                           # 成片注入,填到发送前一步
```

## AI 任务（与界面「AI 帮我…」同一引擎）

`od studio ai <kind> [文章id]`，kind：`topics`(帮我选题) `write`(写一版) `revise`(按意见改) `ai-check`(去 AI 味体检) `script`(口播脚本) `research`(素材调研) `review`(复盘)。

- 默认**同步等待**（内部轮询 run 状态，`--timeout` 秒，缺省 1800）；`--no-follow` 立即返回 runId。
- 产物不在 stdout——AI 子进程用 `od studio set/topic-add` 写回库。跑完看 `od studio article <id>` / `od studio topics`。
- 知识库（`od studio kb`）与账号人设（`--account`）自动注入提示词。

## 发布桥（handoff）机制与排错

```
od studio handoff → daemon 建 job(内存,TTL) → SSE 广播 → 桌面端认领
  → 按文章组稿(与界面「一键存草稿」同一构建器) → 内嵌浏览器注入
  → 进度/终态回写 job → CLI 长轮询打印
```

| 现象 | 原因/处理 |
|---|---|
| exit 4「桌面端未连接」 | 打开 Multimedia 桌面应用后重试 |
| 「未绑定账号」 | 到界面「账号」页绑定，或 `--account 名` 指定 |
| 「稿件没准备好」 | 笔记缺图集/短视频缺成片——`od studio assets <id>` 核对 |
| 等待超时但面板还在动 | 注入未死，看桌面端面板顶部进度条；job 终态可 `GET /api/media-studio/handoff/<jobId>` 查 |
| 知乎/微博 `--auto` | 真实点击平台发布键，**不可撤回**，误发只能到平台删文 |

## 其余对照表（命令 ↔ 界面）

| 命令 | 界面位置 |
|---|---|
| `articles/article/create/set/rm` | 各创作台·文章 |
| `versions/version-save/restore` | 写作·版本历史 |
| `find/topics/topic-add/topic-verify/topic-comments/account-rank/fetch` | 选题台 |
| `image/upload/assets` | 封面·选 / 配图·选 |
| `render/skins/lint/snippets` | 排版/发布预检 |
| `publish/publishes/mark-published` | 发布(公众号草稿箱/发布记录) |
| `handoff` | 发布·一键存草稿/一键发布 |
| `publish-note/publish-video/sau` | 矩阵直传(sau 老路径,界面已收起) |
| `browser open/urls` | 独立档案浏览器(网页版逃生口;登录态与桌面端面板**不互通**) |
| `kb list/add/rm` | 知识库 |
| `ai <kind>` | 各台「AI 帮我…」按钮 |

账号中心（增删平台账号）用 `od account --help`；生图/生视频底层能力用 `od media --help`。

## 功能授权（定制版）

产品支持按客户签发「功能授权」——未授权的功能对客户不渲染，且 daemon 强制
（`/api/media-studio/*` 未授权返回 403 `FEATURE_NOT_LICENSED`）。

- **无授权文件 = 全功能**（开发机/CI/存量安装零影响）。
- 授权文件 `license.json` 放在 daemon 数据目录（与 `app-config.json` 同级）。
- 客户侧命令：`multimedia license show` / `multimedia license import <file>` / `multimedia license reload`。
- 到期后：写操作 403（`LICENSE_EXPIRED`），GET 读端点放行——锁功能、留数据。

签发在运营方侧（私钥不进仓库/产品），见《定制版签发操作单》。
