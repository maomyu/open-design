# 媒体创作台（Media Studio）架构规格

> **产品定位（2026-07-07 用户拍板）：AI 时代的营销平台。** 三个创作台
> （公众号长文 / 短视频 / 图文笔记）构成内容形态矩阵，围绕一个原则：
> **步骤可视化 + 每步智能化**。发布层双轨：自动直传（sau/官方 API）+
> **风控安全发布**（平台×账号隔离的内置浏览器档案，手动交接零自动化指纹）。
> 状态：三台已落地。
> 这是客户定制方向的核心重构：把「完全由智能体+插件驱动的线性工作流」重构为
> 「结构化文章实体 + 可独立使用的分步导航 + 确定性排版/发布」。

## 第一性原理

1. **确定性环节不依赖智能体。** 排版是纯规则转换（markdown → 微信约束下的内联 CSS HTML），
   发布是纯 API 调用（token → uploadimg → add_material → draft/add）。这两步做成产品原生代码，
   点按钮即出结果，可重复、可测试、永不「谎报」。
2. **创造性环节智能体辅助但不垄断。** 选题、写作可以手动，也可以由智能体产出——但产物必须
   落进结构化「文章」实体，而不是聊天记录里的一次性文本。
3. **「文章」是贯穿一切的持久实体。** 四个导航（选题/写作/排版/发布）各自独立操作同一实体，
   因此天然「既紧密相连又可单独分开」：可以只用排版（粘贴任意 markdown），也可以从选题一路走到发布。
4. **平台只是外壳。** wechat-mp 是第一个实现；实体模型、导航模型、路由形状全部平台参数化，
   新平台 = 新 platform id + 平台渲染器/发布器 + 复用同一套 UI 骨架。

## 实体模型（packages/contracts/src/api/media-studio.ts）

- **MediaArticle** — 多层结构的文章：
  - `title`（只进发布的 title 字段，绝不渲染进正文）
  - `headerMd` / `bodyMd` / `footerMd` —— 固定开头、正文、固定结尾三段分层，渲染时拼接
  - `skin`（排版皮肤）、`coverSource`（封面：URL 或本地绝对路径；空则取文内首图）
  - `digest`（摘要）、`topic`（来源选题）、`accountId`（绑定账号）
  - `renderedHtml` / `renderedSkin` / `renderedAt` —— 最近一次「保存排版」的产物
  - `status`: `writing` → `rendered` → `published`
- **MediaTopic** — 选题候选：标题/角度/来源/原文链接/热度/状态（candidate|used）。
- **MediaSnippet** — 可复用固定开头/结尾片段：`slot: header|footer` + 名称 + markdown 内容。
- **MediaPublishRecord** — 每次发布的记录：账号、状态、draft media_id、错误、时间。

## 存储（daemon SQLite，apps/daemon/src/db.ts）

表：`media_articles`、`media_topics`、`media_snippets`、`media_publishes`。
全局存储（不绑定项目）：文章是长期资产，跨对话、跨项目存在。

## API（apps/daemon/src/media-studio-routes.ts）

```
GET/POST           /api/media-studio/:platform/articles
GET/PATCH/DELETE   /api/media-studio/:platform/articles/:id
POST               /api/media-studio/:platform/articles/:id/render     # 渲染并持久化
POST               /api/media-studio/:platform/articles/:id/publish    # 发到草稿箱
GET                /api/media-studio/:platform/articles/:id/publishes
POST               /api/media-studio/render                            # 无状态渲染（实时预览/自由排版）
GET/POST/PATCH/DELETE /api/media-studio/:platform/topics[/:id]
GET/POST/DELETE       /api/media-studio/:platform/snippets[/:id]
```

## 公众号渲染器（apps/daemon/src/media-studio/wechat-render.ts）

确定性 markdown → 微信 HTML，铁律全部代码化（不再依赖提示词遵守）：

- 产物是全内联 CSS 的独立 `<section>` 片段（无 `<style>/<head>/<body>`）；
- 正文永不渲染 H1：输入首行 `# 标题` 自动剥掉，`##`→h2、`###`→h3；
- 列表一律手写序号进 `<p>`（`<strong>1. </strong>` / `· `），绝不输出 `<ol>/<ul>/<li>`；
- 只用微信留得住的标签：`section/p/h2/h3/blockquote/strong/em/span/img/br/a/code`；
- `<!-- IMAGE_N: 描述 -->` 与 `![alt](src)` 都渲染成居中 `<img>`（本地 src 留给发布器替换）；
- 4 套皮肤（kaiti/purple/orangeheart/github）从工作台 styles.json 移植为 TS 常量。

## 公众号发布器（apps/daemon/src/media-studio/wechat-publish.ts）

所见即所发，全部确定性代码：

1. 发布时**用同一渲染器从 md 重新渲染**（预览与草稿同源，不可能不一致）；
2. 凭证走平台账号中心：`resolvePlatformAccountCredentials(prefs,'wechat-mp',账号,[APPID/SECRET/AUTHOR])`；
3. 扫描 HTML 里每个非 mmbiz 的 `<img src>`：http(s) 下载、本地绝对路径读文件 → `uploadimg` → 替换 src；
4. 封面：`coverSource`（无则取文内首图）→ `add_material` → `thumb_media_id`；无任何图则明确报错；
5. `draft/add` 提交（title ≤64 字节校验、digest 兜底取正文前 100 字）；**只发草稿箱，无 freepublish**；
6. 每次发布写 `media_publishes` 记录（成功/失败/卡在哪一步）。

## Web UI（apps/web/src/components/media-studio/）

导航栏新增「公众号」入口（EntryView `media-studio`，路由 `/studio/wechat-mp`）。
页面 = 文章选择器 + 四个子导航：

- **选题**：候选表（手动添加 + 将来接智能体投递），一键「去写作」（选题→新文章）；
- **写作**：标题 / 固定开头 / 正文 / 固定结尾 四层编辑，开头结尾可存为片段库复用，
  右侧**实时预览**（防抖调无状态渲染 API），自动保存；
- **排版**：4 皮肤切换 + 全幅预览 + 「保存排版」（持久化 renderedHtml）+ 复制 HTML；
  也支持不选文章的自由排版（粘贴任意 markdown）；
- **发布**：选账号（平台账号中心）、摘要、封面 → 「发到草稿箱」→ 发布记录列表。

文案约定：本模块是客户定制（纯中文交付），组件内直接写中文文案，不进 i18n 18 语言矩阵
（先例：本 fork 已隐藏多语言场景；若未来回流上游再补 key）。

## CLI（od studio …）

`od studio articles list|create|show`、`od studio render --id|--file`、
`od studio publish --id --account`、`od studio topics list|add`，全部支持 `--json`。

## Phase 2：每一步都有 AI（已落地）

创作台不是去 AI 化——是把插件流水线拆成「每步可视化、可单独触发」。每个导航三层：

- **数据按钮（确定性直调）**：大家来爆文榜/微信搜一搜/双信号雷达（`media-studio/dajiala.ts`）、
  千问生图（`media-studio/qwen-image.ts`，白板/插画/纯净三风格，prompt 铁律代码化）。
  key 一处配置两处用：读 `wechat-mp-publish` 插件配置 + 工作台 .env 兜底（`step-keys.ts`）。
- **AI 动作（scoped agent run）**：AI 帮我选题 / AI 写一版（6 文章类型 × 账号人设 × 贝拉方法论）/
  按我说的改 / 查 AI 腔。`POST /:platform/ai-task` 组提示词（工作台 MY-wechat-* 技能内联 +
  账号人设 + `od studio` 回写指令），web 走既有 `/api/runs` 执行——流式、中止、agent 解析全复用。
  **回写通道 = `od studio` CLI**（agent 与人操作同一实体，UI/CLI 双轨的自然闭环）。
  执行呈现：导航底部折叠实时面板（`StudioAiPanel`），工具调用逐行 + 文字尾巴 + 可中止；
  任务挂在隐藏项目 `media-studio-hub` 下，完整过程可回看。
- **手动兜底**：所有字段永远可手改。

配图是独立第五导航（选题/写作/配图/排版/发布）：扫描正文 `<!-- IMAGE_N: 描述, 比例 -->`
标注逐张生成（成功即替换成 `![](/api/media-studio/assets/...)`，预览立即可见），封面 16:9 单卡。
发布器把资产 URL 映射回本地文件直接上传（`resolveAssetPath`）。

## 导航定稿（2026-07-06 用户拍板）

选题 → 写作（含排版：皮肤/保存排版/复制 HTML 收进写作页，所见即排版）→
**封面（必经步骤**：提示词自定义、可带参考图、生成结果可「存入封面库」跨文章复用，
无封面不能进发布）→ 配图（**可选**）→ 发布（选账号发草稿）。
封面库复用 `media_snippets` 表（`slot: 'cover'`，contentMd 存资产 URL）。

## 知识库挂载（Phase 3，已落地 v1）

`media_knowledge` 表（platform + accountId? + 名称 + 内容），创作台「知识库」
管理面挂载/删除，`ai-tasks.ts` 组提示词时自动注入（平台级 + 绑定账号条目，
每条截 2000 字、最多 6 条）；CLI `od studio kb list/add/rm`。
后续演进：文件/URL 导入、条目多时走检索（先关键词后向量）。

## 用户视角补全（2026-07-06「全做」批次，均已落地）

- **账号（人设）前置**：创作台头部就选账号，新建文章默认绑定第一个账号——
  AI 从第一版就按人设写，不再等到发布步才补。
- **版本历史（后悔药）**：`media_article_versions` 表；AI 覆盖类动作
  （写一版/修改/清AI腔/写脚本）在 daemon 侧自动快照，回退前也快照；
  写作/脚本页「历史版本」卡一键回退；每篇保留最近 20 版。
- **本机图片上传**：`upload-asset`（base64 JSON，20MB 上限）——封面、
  参考图、正文插图都支持文件选择，不再要求用户懂"绝对路径"。
- **文章/作品列表**：「文章」管理面（搜索/状态/账号/打开/删除），两台共享组件。
- **发布预检清单**：标题字节/正文/封面/账号凭证必查项全绿才能点发布，
  每条红项带「去处理」跳转；发成功给「去公众号后台确认群发 →」直达链接。
- **标题实时字节计数**：`N/64 字节`，超限变红并警示。
- **素材简报（research AI 任务）**：从选题建文章保留原文链接（extra.topicUrl），
  agent 经 `article-detail` 端点（大家来直调）抓原文 + 自行补信源，简报写进
  extra.researchMd，「AI 写一版」自动带上。
- **发布复盘（review AI 任务）**：发布后手填实际数据（extra.reviewData），
  AI 定性复盘 + 下一篇建议 + 衍生选题直接落选题库。
- **生图 Gemini 兜底**：千问失败且配了 GEMINI_API_KEY 时自动 spawn 工作台
  gemini 脚本重试。
- **片段库界面化**：存片段/管理片段全部内联 UI，去掉 window.prompt。

## 短视频创作台（2026-07-06 落地）— 第二个创作台，覆盖五个平台插件

`short-video-copy` 总控 + 抖音/小红书/快手/B站/视频号五个发布插件，在用户视角
是一个「短视频创作台」（`/studio/short-video`，platform id `short-video`）：

- **选题**：与公众号共享 `TopicsTab`（大家来数据按钮 + AI 选题），选题库按平台隔离；
- **脚本**：主发平台调性 × 语气 × 时长 → AI 写脚本（标题备选/口播稿/标签/封面文字
  一次到位，`od studio set --tags` 回写）+ 手改 + 实时时长估算（4.5 字/秒）；
- **配音（可选）**：火山复刻音色 TTS——daemon spawn 工作台 `volc_tts.py`
  （`media-studio/volc-tts.ts`），wav 进资产目录直接试听；
- **成片**：本机路径（AI 生成视频仍走插件流水线，成片路径填回）；
- **发布**：五平台 × sau cookie 档案矩阵——「检查登录」真实调 `sau <p> check`、
  「扫码登录」弹本机浏览器（`sau login --headed`）、发布前**明细二次确认**
  （对外动作铁律）→ 逐平台 `sau upload-video` → 发布记录。
  实体平台特有字段（videoPath/audioUrl/tags/voice/tone…）存 `media_articles.extra_json`。

用户视角的交互约定（两个创作台一致）：步骤条带**完成态 ✓**、可选步标「·选」、
必经步未完成时下一步禁用并给原因、所有错误带「去哪修」的动作指引、
右侧始终有「发布时的样子」预览（公众号=手机排版预览，短视频=作品卡）。

## 图文笔记创作台（2026-07-07 落地）— 第三台，内容形态矩阵补全

`/studio/note`（platform id `note`）：小红书为主的图文笔记，抖音/快手也收图文。
选题(共享 TopicsTab, AI-only) → 文案(≤20 字标题/≤1000 字正文/标签实时计数，
「AI 写笔记」小红书调性一键全流程：调研→写→图集画面建议落 extra.imageIdeas→清腔)
→ 图集(按建议批量生成 3:4 竖图/单张生成/多选上传/排序/删除，1-18 张，
extra.noteImages 资产 URL 数组，第 1 张即封面) → 发布(sau upload-note
小红书/抖音/快手矩阵 + 登录管理 + 定时 + 敏感词警示 + 明细二次确认)。
CLI: `od studio publish-note <id> --targets xiaohongshu:main`。

## P1 安全与节奏（2026-07-07）

- **敏感词预检**：daemon 词库(广告法极限词/承诺保证/医疗金融高危/平台敏感方向)，
  `POST /:platform/articles/:id/lint`；公众号进预检清单(警示项+明细卡)，
  短视频/笔记发布页红条提示。警示不阻断——误报由用户判断。
- **定时发布**：短视频与笔记发布支持 datetime 定时（sau `--schedule` 原生）。

## 风控安全发布体系（2026-07-07 落地）

自动化发布在小红书等平台有风控风险（限流/封号）。双轨设计：

- **安全发布（推荐）**：每个 平台×账号 一份独立浏览器档案，一键直达各平台
  创作者发布页（PLATFORM_PUBLISH_URLS）。`SafeHandoffCard` 四步可视化：
  复制文案（平台化格式）→ 打开图集文件夹（访达）→ 打开专属浏览器 →
  回来「标记完成」（入发布记录+状态推进）。登录态在档案里长期保持，
  多账号永不串号，零自动化指纹。
- **自动发布**：sau 直传保留（抖音/快手图文、五平台视频）；小红书自动
  默认不勾选并带风控提示。公众号本就只发草稿箱（安全）。

「专属浏览器」按运行环境自动选择实现（web 端 `openStudioBrowser` 内部决策）：

- **应用内置浏览器（桌面壳，2026-07-07 落地，首选）**：`@open-design/host`
  暴露可选 `browser.openProfile` 能力（IPC `od:browser:open-profile`），
  `apps/desktop/src/main/embedded-browser.ts` 为每个 平台×账号 创建持久
  session partition（`persist:od-browser-<平台>-<账号>`）的沙箱窗口——
  无 preload、无 node、UA 去掉 Electron/应用名指纹、登录弹窗同分区放行、
  非 http(s) 一律拒绝、同档案窗口复用聚焦。档案数据在应用 userData 的
  `Partitions/` 下持久保存。
- **外部 Chrome 档案（网页版降级）**：daemon `media-studio/browser.ts` 以
  `user-data-dir`（`<数据目录>/browser-profiles/<平台>-<账号>/`）拉起本机
  Chrome/Chromium/Edge。桌面桥不可用或打开失败时自动走此路。

## 与既有插件工作流的关系

`wechat-mp-publish` 插件（对话式全自动流水线）保留不动，适合「一句话全托管」；
创作台适合「人主导、分步掌控」。二者共享账号中心与凭证。
Phase 2：插件各步骤产物直接写入文章库（写稿→article.bodyMd），两条动线在同一实体上会合；
写作导航加「AI 写一版 / AI 改写」按钮（发起单步 agent run，产出回填 bodyMd）。

## 营销平台路线图（2026-07-07 规划定稿）

营销闭环 = 策略 → 生产 → 分发 → 数据 → 增长。现状：生产（三台）与分发（双轨）
已强，策略（选题数据+AI）中等，数据与增长环节是下一步主战场。

### Phase A · 产能跃迁（下一批，发令即开工）
1. **Autopilot 批量生产线**：方向+篇数+账号 → AI 队列产出 N 篇全成品
   （文+封面+配图/图集），状态「待审」；审核视图逐篇 通过→发布 / 按建议改 / 弃。
   原子能力全部现成（写作全流程任务已会调生图端点），新增：produce 编排任务 +
   任务队列显示 + extra.reviewState 审核流。验收：给一个方向，出 3 篇待审成品，
   人只做审核和点发布。
2. **内容日历**：账号 × 日期周视图——格子=已发（发布记录）/已排期（定时）/空缺，
   点空缺直达该账号选题开工。多账号矩阵的管理主视图。

### Phase B · 数据与增长闭环
3. **数据回流结构化**：复盘手填升级为分字段（阅读/赞/藏/评/转）+ 文章列表趋势
   微图；调研公众号官方数据接口与大家来账号接口的自动回流可行性。
4. **爆款资产沉淀**：复盘数据好 → 一键「存为账号范文/知识库」——AI 越写越像
   自己的爆款（数据驱动的风格进化闭环）。
5. **A/B 标题工场**：AI 出 5 个标题 → 对照账号爆款库评分 → 点选替换。

### Phase C · 形态与效率
6. **图文自动成片**：口播稿 + TTS 配音 + 生成图 → ffmpeg 本机合成字幕幻灯片
   视频（信息服务类内容零剪辑出片），短视频台「成片」步从填路径变一键生成。
7. **知识库 2.0**：文件/URL 导入、自动切块、按任务关键词检索注入（替代全量内联）。
8. **安全发布增强**：分段复制（标题/正文/标签各一键）、发布页填写助手。

### Phase D · 矩阵运营系统
9. **评论区运营辅助**：专属浏览器看评论，粘贴进来 AI 出回复话术（人设一致）。
10. **线索承接**：发布记录关联转化备注，轻量线索表——营销闭环的最后一米。

优先级判断：A1 是产能质变（10 倍产出的关键）、A2 是多账号刚需；B4 成本最低
收益长期；C6 依赖批量生图地基（已具备）。建议执行顺序 A1 → A2 → B4 → C6 → B3。

## 新平台扩展配方

1. contracts：`platform` id 加入联合类型（保持 string 兜底）；
2. daemon：实现该平台的 `render`（若有排版概念）与 `publish` 模块，路由复用；
3. web：`MediaStudioView` 传入平台配置（名称/皮肤集/发布字段），骨架复用；
4. 账号中心已平台化（platformAccounts[platformId]），凭证 key 由平台定义。
