# WorkBuild 功能清单与授权颗粒度（单一真源）

> **这是产品所有可授权功能的唯一真源。** 任何功能的新增/重做/删除，都必须
> 先对照本表，再同步下方「五处同步点」，否则产品和授权会漂移（客户买了却
> 用不了 / 没买却能用）。维护纪律见文末。

最后更新：2026-07-12（授权颗粒度全面平台化落地）

---

## 一、授权单元总表

颗粒度分三层：**平台层**（客户买"能发哪些平台"）、**能力层**（横切所有平台的
功能）、**导航层**（由平台/能力自动派生，不单独授权）。

| 功能 id | 中文 | 层 | 状态 | 对应界面 | daemon 强制点 |
|---|---|---|---|---|---|
| `article.wechat-mp` | 公众号文章 | 平台 | ✅已实现 | 文章台·公众号 | `/wechat-mp/*` |
| `article.zhihu` | 知乎文章 | 平台 | ✅已实现 | 文章台·知乎 | `/zhihu/*` |
| `article.weibo` | 微博文章 | 平台 | ✅已实现 | 文章台·微博 | `/weibo/*` |
| `sv.douyin` | 抖音短视频 | 平台 | ✅已实现 | 短视频台·抖音 pill | handoff/发布目标=douyin |
| `sv.kuaishou` | 快手短视频 | 平台 | ✅已实现 | 短视频台·快手 pill | handoff/发布目标=kuaishou |
| `sv.shipinhao` | 视频号短视频 | 平台 | ✅已实现 | 短视频台·视频号 pill | handoff/发布目标=tencent |
| `sv.bilibili` | B站短视频 | 平台 | ✅已实现 | 短视频台·B站 pill | handoff/发布目标=bilibili |
| `sv.xiaohongshu` | 小红书视频 | 平台 | ✅已实现 | 短视频台·小红书 pill | handoff/发布目标=xiaohongshu(视频) |
| `note.xiaohongshu` | 小红书图文笔记 | 平台 | ✅已实现 | 笔记台 | `/note/*` |
| `integrations` | 集成 | 平台 | ✅已实现 | 集成 | — |
| `cap.ai` | AI 选题/写作/改写（含知识库） | 能力 | ✅已实现 | 各台 AI 卡 + 知识库 | `/ai-task` + `/knowledge` |
| `cap.image` | 封面/配图生成 | 能力 | ✅已实现 | 封面/配图 tab | `/images` |
| `cap.tts` | 配音 | 能力 | ✅已实现 | 短视频·配音 tab | `/tts` |
| `cap.handoff` | 一键填稿/发布（浏览器注入） | 能力 | ✅已实现 | 一键填稿/发布按钮 | `/handoff` |
| `cap.publish` | 发布（公众号草稿箱等） | 能力 | ✅已实现 | 发布 tab | `/publish*` |

> **短视频强制说明**：URL 是共享池 `/short-video/*`（不带具体平台），所以 studio 级
> 访问（建作/AI/配图）只需「任一 sv.\*」；**per-平台的真正强制在发布/handoff 边界**
> （目标平台在 body 里）——handoff 到抖音需 `sv.douyin`。小红书 handoff 图文/视频
> 歧义，持 `note.xiaohongshu` 或 `sv.xiaohongshu` 其一即放行（anyOf）。

**导航层派生规则（不单独授权，纯函数见 `license.ts` 派生区）**
- 「文章」导航 = 有任一 `article.*`（`hasAnyArticleFeature`）
- 「短视频」导航 = 有任一 `sv.*`（`hasAnyShortVideoFeature`）
- 「笔记」导航 = 有 `note.xiaohongshu`
- 「知识库」导航 = 有任一 `kb.*`（2026-07-16 拆 kb.personal/kb.enterprise 后跟 kb 走，
  不再挂 `cap.ai`；两套都授权则知识库页出 tab 切换）
- 「账号」导航 = 有任一发布平台（`hasAnyPublishingModule`）
- 账号页「运维块」(OpsSection：近7天成本/失败队列重试/备份迁移/开机自启) = 有任一
  `sv.*`（2026-07-17 双包交付：运维是短视频引擎的面板，文章包不显示，账号页只留发布账号）
- 平台一级导航(2026-07-17 平台化):抖音/快手/B站/视频号入口 = 对应 sv.*;小红书入口 = sv.xiaohongshu 或 note.xiaohongshu 任一(入口内 图文/视频 tab 分别按各自 feature 裁);「制作视频」入口 = cap.video(数字人口型替换,daemon make-video 路径同门禁)
- 短视频台内 pill = 每平台按 `svFeatureOf(sauId)` 裁剪
- 选题「爆款筛选」(时间窗/播放/点赞规则) = 仅短视频采集模式(browserCollect)渲染

**打包内置 license（双包交付机制，2026-07-17）**
- `OD_PACK_LICENSE_FILE=<已签发license>` → tools-pack 烤进包资源
  `Resources/open-design/license.json`；daemon 数据目录无运行时 license 时回落读它
  （`loadLicenseState` 第 4 参）。运行时 `license import` 落数据目录后优先。
- 身份 env：`OD_PACK_PRODUCT_NAME` / `OD_PACK_APP_ID`（mac constants/identity 单点覆盖，
  bundle/产物名/userData 全跟随）。翟总双包见 `customers/中国维澳-翟总/manifest.json`。

---

## 二、当前漂移

> 无。上表与代码一致（2026-07-17 复核：补记 kb.* 知识库导航、运维块 sv.* 门禁、
> 爆款筛选 browserCollect 门禁、打包内置 license 机制）。
> 短视频台的独立 DB 池拆分仍是"将来真要每平台分化功能时再做"（见短视频重构
> 计划），但那是数据模型演进，不影响授权颗粒度——授权已按平台设计好。

---

## 三、五处同步点（改功能必须一起改）

新增/重做/删一个功能时，按顺序核对：

1. **本表** `docs/feature-license-catalog.md` — 加/改/删行，更新状态。
2. **授权枚举** `packages/contracts/src/api/license.ts` — `FeatureId` 联合类型
   + `ALL_FEATURE_IDS` + 派生纯函数（`moduleFeatureOf*` 等）。
3. **daemon 强制** `apps/daemon/src/license.ts` — `requiredFeaturesFor()` 的
   URL→功能映射（新平台/能力要能被拦）。加对应单测。
4. **web 裁剪** `apps/web/src/state/license.ts`（`isViewLicensed`）+ 各创作台/
   导航的 `hasFeature()` 判断（EntryNavRail、EntryShell、各 Shell、能力卡）。
5. **签发工具与操作单** — `apps/daemon/scripts/license-tool.ts` 的功能清单提示
   + 客户目录《定制版签发操作单.md》的功能表。

> daemon 是唯一强制点，UI 只是体验层——**新功能的授权拦截一定要落在第 3 步**，
> 光改 UI（第 4 步）是假的，CLI/智能体照样能绕过。

---

## 四、维护纪律（给 AI 与人）

- **改功能前先读本表**：把要动的功能和表里逐条对比，确认它属于哪个授权单元、
  颗粒度是否要变（拆平台？升为能力？）。
- **平台化是产品方向**：新内容形态优先按"平台层"设计授权单元（一个平台一个
  开关），不要图省事做成模块级——否则将来拆分要返工（短视频就踩过这个坑）。
- **删功能**：从上表和五处同步点一并移除；已签发的老授权若含该 id，`license.ts`
  验签会因"未知功能项"拒绝（前向保护），需给客户重签。
- **状态标记**：✅已实现 / 🔲待落地 / ⚠️漂移中。表和代码不一致就是 bug。
