# 自媒体营销机器人（桌面端）· 前三阶段开发规划与测试方案

> 客户：翟总客户（企业客户，自带企业知识库，保持不动）。乙方：煜之禾科技。
> 本分支：`video-auto-油炸老总-爆款引擎`，产品/品牌 social-auto，桌面端交付。
> 合同为「纯服务器版」，客户现接受桌面端交付；互动执行器按「浏览器驱动可替换」设计，未来若回迁服务器不推倒重来。
> 本文只覆盖合同**前三阶段**；第四阶段（微信 RPA）、第五阶段（数据/日志/告警联调）暂不排期。

---

## 0. 现状基线（已有能力，绝不重复造）

三个子系统探查（执行层 / 登录态·调度 / 平台扩展）确认的现成能力：

| 能力 | 现状 | 关键文件 |
| --- | --- | --- |
| 任务调度器（真实 in-process 循环，带时区/DST） | ✅ 已有，但只驱动 agent prompt，非确定性发布 | `apps/daemon/src/routines.ts`、`routine-routes.ts`、`server.ts:13870` |
| 任务记忆/配置持久化 | ✅ daemon SQLite（`routines`/`routine_runs`/`media_*`） | `apps/daemon/src/db.ts`、引擎 `store.py` |
| 登录态/cookie 持久化（cookie vault） | ✅ 已有（signed 包 Chromium 存不了 cookie 的兜底），按 平台×账号 分区 | `apps/desktop/src/main/embedded-browser.ts:44-196` |
| 人类行为模拟（拟人打字/真实坐标点击/换气停顿/验证码等待） | ✅ 很完整，可直接复用 | `apps/web/src/runtime/browser-draft.ts`、`BrowserPanesHost.tsx` |
| 敏感词检测（发布预检 lint） | ✅ 已有 | `apps/daemon/src/media-studio-routes.ts`（lint）、`cli.ts` |
| AI 文案改写/仿写 | ✅ 已有（知识库注入 + rewrite/imitate） | `apps/daemon/src/media-studio/ai-tasks.ts` |
| 企业知识库（素材上下文） | ✅ 已有，个人/企业双套按 license；**保持不动** | `apps/web/src/components/media-studio/KnowledgeView.tsx`、`media_knowledge` 表 |
| 内置浏览器采集（检索）框架 | ✅ 已有 job bus + 提取器模式 | `apps/daemon/src/media-studio/collect-jobs.ts`、`apps/web/src/runtime/collect-extractors.ts` |

**四平台 × 三能力 现状矩阵**（合同要求平台：小红书、知乎、微博、百度知道）：

| 平台 | 发布 | 关键词检索 | 自动评论回复 |
| --- | --- | --- | --- |
| 小红书 | ✅ 笔记台 + sau/handoff | ✅ TikHub + 浏览器采集 | ❌ |
| 知乎 | ✅ handoff 注入（支持 `--auto` 真发） | ✅ TikHub `zhihuSearch` 已接线 | ❌ |
| 微博 | ✅ handoff 注入（填到发送前一步） | ✅ TikHub `weiboSearch` **已接线**（仅需验证 `TIKHUB_API_KEY`） | ❌ |
| 百度知道 | ❌ 全无 | ❌ 全无 | ❌ |

**净新增只有两大块**：①各平台的**互动执行**（评论/楼中楼/私信读取 + 注入）；②**百度知道**整个平台。其余（地基、检索、发布、AI 改写）多为「已完成」或「已完成待验证」。

---

## 1. 架构决策（先定，后面全复用）

- **D1 互动执行器 = 复制现有 collect 引擎的形状**（读页面→执行动作）。job bus / SSE / 内置浏览器会话层 / 人类行为工具箱全部复用。先把 `browser-draft.ts` 的私有原语（`typeText`/`clickRealByText`/`humanClickAt`/`moveMouseHuman`/`isLoginWall`）抽到共享 `apps/web/src/runtime/webview-primitives.ts` 并导出。
- **D2 新增两张持久化表**：`media_interactions`（互动审计：平台/账号/动作/目标/文本/状态/时间）+ `media_interaction_quota`（按账号限流台账：当日计数、冷却窗口、上次动作时间）。合同的「频率限流/养号节奏」= 复用 intra-action 拟人模拟（现成）+ 新建 inter-action 限流门控（净新增，跨重启不丢）。
- **D3 定时发布 = RoutineService 新增 `media-publish` action 分支**（确定性，不走 LLM）。headless-safe 只有 微信 API + sau 上传；注入类平台（知乎/微博/小红书/百度知道）需桌面在线——合同为桌面端交付，可接受，但要在 UI 明示「定时注入发布需保持应用运行」。
- **D4 内容轮发 = 新内容池表 + 轮转游标**（知识库是 AI 上下文不是发布队列，不复用）。
- **D5 登录态保活 = 桌面侧探针**（镜像 `handoff-listener` 的 claim/execute 模式，因 daemon 读不到 Electron 分区），覆盖**两套割裂登录态**（内置浏览器分区 + sau profile）。账号模型加 `loginStatus`/`lastCheckedAt`；告警走现有 SSE 广播 + 新 `media_alerts` 表；AccountsView 加实时状态 + 「点此扫码补登」入口。
- **D6 关键词匹配规则引擎 = 新 `interaction_rules` 表 + 匹配器**，产出回复文本（可接 AI 改写）喂给互动执行器。
- **D7 百度知道 = ArticleStudioShell 加第 4 个 pill**（省掉 nav/router/license-view 四处改动）。重头是 `injectBaiduZhidao`（问答**回答**注入，不是文章标题+正文）。`MediaStudioPlatform` 是开放 union，**无需 DB 迁移**；studio 模块**不进 i18n**（0 locale key）。
- **D8 代理池**：桌面单机 + 真人节奏场景需求弱 → 建议与客户确认**降级为「预留框架/接口」**（配置位 + 注入点留好，不实装采买代理）。写进阶段一交付说明。

**需与客户在各阶段启动前确认的决策门（合同约定每阶段有专属需求文档）**：
1. 阶段一首发平台 = **小红书**（现成能力最厚，建议）——合同要求开工前确认。
2. 微博检索：现有 TikHub 搜索是否够用，还是要做 scored/criteria 打分管线（现微博未走打分管线）。
3. 百度知道检索：走 TikHub 百度端点（需确认可用性+计费）还是内置浏览器抓取。
4. 代理池：预留接口 vs 实装（见 D8）。

---

## 2. 阶段一：系统地基 + 三大痛点根治 + 单平台（小红书）跑通

> 合同交付物：可运行的调度+登录态+账号管理+风控底座；单平台发布/检索/评论模块与端到端演示；可复用适配模板、管理后台雏形、部署文档。

| ID | 工作内容 | 落地位置 | 现成度 | 测试方法（边开发边测） |
| --- | --- | --- | --- | --- |
| **W1** 风控限流台账 | `media_interactions` + `media_interaction_quota` 表；限流门控（当日上限/冷却窗/账号级）；inter-action 随机间隔（30–120s）+ 静默时段 | `db.ts`（建表+migrate）、`store.ts`（CRUD）、新 `media-studio/interaction-quota.ts`（门控） | 🟡 拟人模拟已有；台账净新增 | 红 spec（daemon HTTP e2e Vitest）：第 N 次动作被拦、冷却期拦截、跨日重置、并发只放行一个 |
| **W2** 互动执行器框架 | 抽 `webview-primitives.ts`；`interaction-jobs.ts` bus（复制 handoff-jobs）；路由 `/interaction` + SSE + claim/progress/complete/wait；`interaction-listener.ts`；`BrowserPanesHost` 加 `interact` 分支；contracts `InteractionJob` | daemon `media-studio-routes.ts`、`interaction-jobs.ts`；web `runtime/interaction-listener.ts`、`browser-panes.ts`、`BrowserPanesHost.tsx`；`packages/contracts` | 🟡 bus/SSE/会话层复用，逻辑新增 | e2e：job 生命周期（create→claim→progress→complete、desktop-offline 快失败）；Playwright：listener 挂载 |
| **W3** 评论读取器（小红书） | 笔记评论/楼中楼提取器（新 webview extractor，读评论树，非搜索卡片） | `apps/web/src/runtime/`（新 comment-extractors）、复用 collect bus | ❌ 净新增（现只抓搜索卡片） | 提取器单测（离线 HTML 夹具）+ 真机手测（真实笔记评论树） |
| **W4** 自动评论回复注入（小红书） | `injectXhsReply`（定位评论框→拟人输入→发送；楼中楼先点目标评论的「回复」）；受 W1 门控 | `browser-draft.ts` ADAPTERS 扩展 | ❌ 净新增 | 真机手测（双命名空间 buggy-vs-fix，只经生产 HTTP API 造数据）；门控被 W1 台账拦截可复现 |
| **W5** 关键词匹配规则引擎（基础版） | `interaction_rules` 表 + 匹配器：命中关键词→回复模板/AI 改写 | daemon 新 `interaction-rules.ts`、`db.ts`、`store.ts` | ❌ 净新增 | 匹配器单测（关键词命中/优先级/兜底）；e2e：评论→规则→回复文本 |
| **W6** 登录态保活+失效告警+扫码补登 | 账号模型加 `loginStatus`/`lastCheckedAt`；桌面侧探针（镜像 handoff-listener，覆盖两套登录态）；心跳循环；`media_alerts` 表 + SSE 告警；AccountsView 状态灯 + 补登入口 | daemon `account-routes.ts`、`routines.ts`/新探针、`db.ts`；desktop 探针；web `AccountsView.tsx` | 🟡 cookie vault 已有；心跳/告警/补登净新增 | e2e：探针结果落库、失效触发告警事件；Playwright：状态灯渲染；真机：补登扫码 |
| **W7** 多账号分组 + 状态监控面板 | 账号加分组字段；AccountsView 分组 UI + 实时登录状态汇总面板 | `account-routes.ts`、`AccountsView.tsx`、contracts | 🟡 多账号已有，分组/面板新增 | Playwright：分组渲染、状态汇总 |
| **W8** 小红书端到端串通 + od CLI 双轨 | 发布(已有)+检索(已有)+评论回复(W3-W5) 串成可演示链路；`od studio reply` / `od interaction` 子命令（UI/CLI 双轨红线） | `cli.ts`、串接各模块 | 🟡 组装 | 人工端到端演示脚本（采集→选题→写作→发布→自动评论回复全链路） |

**阶段一验收锚点**：调度+登录态+账号+风控底座可运行；小红书 发布/检索/评论 端到端演示通过；限流台账真实拦截；登录失效有告警且能扫码补登；部署文档 + 可复用适配模板产出。

---

## 3. 阶段二：其余平台扩展（知乎 / 微博 / 百度知道）

> 策略：先单平台（小红书）跑通验证 → 复制扩展。发布+检索已就绪的平台只补「评论执行」，百度知道整平台新建。顺序建议：**知乎 → 微博 → 百度知道**（前两个有底子，百度知道全新放最后）。

| ID | 工作内容 | 落地位置 | 现成度 | 测试方法 |
| --- | --- | --- | --- | --- |
| **W9** 知乎评论执行适配 | `injectZhihuReply` + 知乎评论/回答读取器；接 W1-W5 框架 | `browser-draft.ts`、comment-extractors | 🟡 复用框架，加适配 | 提取器单测 + 真机手测 |
| **W10** 微博评论执行适配 | `injectWeiboReply` + 微博评论读取器 | 同上 | 🟡 复用框架 | 同上 |
| **W11** 微博检索校验 | 确认 TikHub `weiboSearch` 已接线可用（`TIKHUB_API_KEY`）；与客户确认是否要打分管线 | 验证为主 | ✅ 已接线待验证 | e2e：`/topics/tikhub-feed` target=weibo 返回；真机点「搜微博」 |
| **W12** 百度知道 平台落地 | `BaiduZhidaoStudioView`（克隆 ZhihuStudioView，问答标签）；contracts（`MediaPlatformId`+`MEDIA_PLATFORMS`+`StudioHandoffPlatform`）；license（`FeatureId`/`articleFeatureOf`/`handoffTargetFeatures`）；`ArticleStudioShell` 第4 pill；`draft-builders` 新 case；`injectBaiduZhidao`（**问答回答注入**，最大新逻辑）；`browser.ts` 发布 URL；`handoff-jobs` HANDOFF_PLATFORMS | ~10-13 文件（清单见 §6） | ❌ 净新增，0 DB 迁移、0 i18n | typecheck（枚举扩展）+ Playwright（视图渲染）+ 真机（回答发布） |
| **W13** 百度知道 检索 | `baiduZhidaoSearch`（确认 TikHub 百度端点）或内置浏览器抓取（collect bus + 问答卡解析） | `tikhub.ts` + 路由 `okTargets`，或 collect-extractors | ❌ 净新增 | e2e：feed 返回；真机搜索 |
| **W14** 百度知道 评论/互动 | `injectBaiduReply` | `browser-draft.ts` | ❌ 净新增 | 真机手测 |

**阶段二验收锚点**：四平台齐全的发布/检索/评论模块；各平台操作演示通过。

---

## 4. 阶段三：内容自动化供给 + 全场景互动

> 合同交付物：定时任务系统、素材库、AI 文案改写模块、互动自动回复模块。

| ID | 工作内容 | 落地位置 | 现成度 | 测试方法 |
| --- | --- | --- | --- | --- |
| **W15** 定时/循环发布 + 配置永久保存 | RoutineService 新增 `media-publish` action 分支（确定性发布，不走 LLM）；持久化；UI 明示注入类平台需应用在线 | `server.ts`（run handler 加分支）、`routines.ts`、`routine-routes.ts`、contracts | 🟡 调度器已有，发布 action 新增 | e2e：定时槽触发 `publishWechatDraft`/sau；注入路径桌面在线校验 |
| **W16** 素材库 + 内容轮发 | 新内容池表 + 轮转游标；routine action 取下一条发布；不重复直到轮空再回环 | daemon 新 `content-pool.ts`、`db.ts`、`store.ts` | ❌ 净新增 | e2e：轮转不重复、轮空回环、多账号各自游标 |
| **W17** AI 文案改写收尾 | 核验现有 rewrite 覆盖「差异化文案避免重复判定」；按平台补润色分支 | `ai-tasks.ts` | ✅ 大体已有 | e2e：同源改写产出差异；相似度自查 |
| **W18** 全场景互动扩展 | 私信（DM 收件箱读取 + 发送）；楼中楼/多层留言（扩展 W2-W4 的回复树遍历） | `interaction-*`、`browser-draft.ts`、comment-extractors | 🟡 建在阶段一框架上 | 真机手测（私信/多层回复），门控受 W1 |
| **W19** 关键词匹配规则细化引擎 | 扩展 W5：多级规则、优先级、按账号、静默时段、正则/同义词 | `interaction-rules.ts` | 🟡 扩展 W5 | 匹配器单测（多级/优先级/时段） |

**阶段三验收锚点**：定时任务系统 + 素材轮发跑通；AI 改写模块；私信/楼中楼/多层留言自动回复模块。

---

## 5. 测试策略（边开发边测，有问题立即修）

**分层（从便宜到贵，能低层测就不上高层）**：
1. **红 spec 优先**：缺陷/新功能先写会红的测试，再改源码。默认落在 **daemon HTTP 边界的 e2e Vitest**（最便宜且能看到症状）。
2. **daemon e2e**（`e2e/tests/`）：job bus 生命周期、限流台账、routine 发布 action、内容池轮转、契约形状、规则匹配器。
3. **app-local Vitest**：`apps/daemon`、`apps/web`、`packages/contracts` 包内单测（提取器夹具、纯函数）。
4. **Playwright UI**（`e2e/ui/`）：新视图/面板/状态灯渲染与交互。
5. **人工真机验证**：注入发布/评论、登录墙、验证码——单测看不见，必须人眼。用「双命名空间 buggy-vs-fix」对照（main vs 本分支），**只经生产 HTTP API 造数据**，不用源码测试后门。

**门禁（每次交付前）**：`pnpm guard` + 相关包 `typecheck` + 改动匹配的包级测试。禁止 root `pnpm test`/`build` 别名。多命名空间/端口/路径改动按 AGENTS.md 验证要求跑 `tools-dev status/logs --json`。

**开发运行时隔离**：一律 `./start-social-auto.sh`（namespace social-auto / ~/.social-auto / 4720+4820），绝不碰其他客户的 baochuang 实例。

---

## 6. 百度知道 端到端改动清单（W12，文件级）

**新建**：`apps/web/src/components/media-studio/BaiduZhidaoStudioView.tsx`（克隆 ZhihuStudioView）。

**改 contracts**：
- `packages/contracts/src/api/plugin-source.ts`：`MediaPlatformId`（+`baidu-zhidao`）、`MEDIA_PLATFORMS[]`（+ def）。
- `packages/contracts/src/api/license.ts`：`FeatureId`/`ALL_FEATURE_IDS`（+`article.baidu-zhidao`）、`articleFeatureOf`、`handoffTargetFeatures`。
- `packages/contracts/src/api/media-studio.ts`：`StudioHandoffPlatform`（+`baidu-zhidao`）、必要时 `TikhubFeedRequest.target`。

**改 web**：`ArticleStudioShell.tsx`（第4 pill：type/PLATFORMS/render 分支）、`draft-builders.ts`（新 case）、`runtime/browser-draft.ts`（`injectBaiduZhidao`+`ADAPTERS`+`DRAFT_PLATFORM_LABEL`+`DRAFT_PUBLISH_URL`）。

**改 daemon**：`media-studio/browser.ts`（`PLATFORM_PUBLISH_URLS`）、`media-studio/handoff-jobs.ts`（`HANDOFF_PLATFORMS`）、（若走 TikHub 检索）`tikhub.ts`+`media-studio-routes.ts` okTargets。

**无需改**：DB 迁移（开放 union）、i18n（studio 不进 locale）、daemon license 放行逻辑（按 contract 派生）。

---

## 7. 合同需求 → 状态 → 任务 追踪矩阵

| 合同条目 | 阶段 | 状态 | 任务 |
| --- | --- | --- | --- |
| 任务调度/队列/断点续跑/配置持久化 | 一① | 🟡 调度器已有，缺确定性发布 action | W15（发布 action）+ 现成 |
| 登录态持久化 | 一② | ✅ cookie vault 已有 | 现成 |
| 保活心跳 + 失效告警 + 扫码补登 | 一② | ❌ 净新增 | W6 |
| 多账号分组管理 + 状态监控面板 | 一③ | 🟡 多账号已有，缺分组/面板 | W7 |
| 风控底座：操作限流 | 一④ | ❌ 台账净新增 | W1 |
| 风控底座：真人行为模拟 | 一④ | ✅ 已有，复用 | 现成 |
| 风控底座：敏感词检测 | 一④ | ✅ 已有 | 现成 |
| 风控底座：代理池适配框架 | 一④ | 🟡 建议预留接口 | D8（待客户确认） |
| 单平台 发布 | 一⑤ | ✅ 小红书已有 | 现成 |
| 单平台 关键词检索 | 一⑤ | ✅ 小红书已有 | 现成 |
| 单平台 自动评论回复 | 一⑤ | ❌ 净新增 | W2-W5, W8 |
| 其余 3 平台 发布 | 二① | ✅ 知乎/微博已有；百度知道新建 | W12 |
| 其余 3 平台 检索 | 二① | ✅ 知乎/微博已有；百度知道新建 | W11, W13 |
| 其余 3 平台 评论回复 | 二① | ❌ 净新增 | W9, W10, W14 |
| 定时/循环任务 + 配置永久保存 | 三① | 🟡 调度器已有，缺发布 action | W15 |
| 素材库 + 内容轮发 | 三② | ❌ 轮发净新增（知识库=素材上下文，不复用） | W16 |
| AI 文案改写 | 三③ | ✅ 大体已有 | W17 |
| 全场景互动（私信/楼中楼/多层留言） | 三④ | ❌ 净新增（建在阶段一框架上） | W18 |
| 关键词匹配规则细化引擎 | 三⑤ | ❌ 净新增 | W5→W19 |

**一句话**：地基与内容侧多为「已完成/待验证」，真正的开发量集中在**互动运营**这半边（互动执行器框架 W2 是纲）+ **百度知道**整平台 W12 + **定时发布/轮发/保活告警**三处接线。
