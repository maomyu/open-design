# 油炸老总

- **slug**：`youzha`　别名：油炸老总 / 油炸
- **定位**：AI 自媒体营销机器人（桌面版）。合同为「纯服务器版」，客户接受**桌面端**交付。
- **版本**：custom
- **进度**：需求已确认（= 合同）。互动运营主线开发中（见 `specs/current/social-robot-phase1-3-plan.md`）。

## 需求（合同：AI自媒体营销机器人 · 前三阶段）

内容平台 **4 个（图文/问答/微博类，无短视频）**，每个平台能力 = 自动发布 + 关键词检索 + 自动评论回复：

| 平台 | feature id | 状态 |
| --- | --- | --- |
| 小红书（图文） | `note.xiaohongshu` | ✅ |
| 知乎 | `article.zhihu` | ✅ |
| 微博 | `article.weibo` | ✅ |
| 百度知道 | `article.baidu-zhidao` | ⏳ 待 W12 平台落地后建 id 并加进 features |

配套能力：企业知识库（`kb.enterprise`）、集成/媒体设置（`integrations`，配 TikHub key 做检索）、
AI 选题/写作/改写（`cap.ai`）、配图（`cap.image`）、发布注入 + 发布（`cap.handoff` / `cap.publish`）。

阶段划分与开发计划见 `specs/current/social-robot-phase1-3-plan.md`（W1–W19）。第四阶段微信 RPA、
第五阶段数据/日志/告警暂不排期。

## 刻意不含（合同外，勿加 feature）

- **公众号**（`article.wechat-mp`）——不在合同平台内。
- **全部短视频平台**（`sv.douyin` / `sv.kuaishou` / `sv.bilibili` / `sv.shipinhao` / `sv.xiaohongshu`）
  ——合同无短视频需求。创作台里的短视频形态/源平台是超集，靠不发这些 feature 自动隐藏，无需删码。
- **配音**（`cap.tts`）、**制作视频**（`cap.video`）——短视频/视频制作能力，合同无。

## 备注

- `features` 已按合同填好（百度知道那格待 W12）。**打包给客户前**再确认一遍 features 与合同一致。
- 品牌/打包名统一 `social-auto`（见根 `CLAUDE.md`）。
