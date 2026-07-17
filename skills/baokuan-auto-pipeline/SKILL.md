---
name: 爆款采集自动化流水线
description: 用 od baokuan 原子命令跑自媒体爆款采集全链路——关键词/竞品/单链接采集、评分、拆解、脚本、复盘全自动写飞书,并教你如何配置定时任务实现全天候自动运行。桌面端只出原子能力,工作流由智能体编排。
triggers: [爆款采集, 定时采集, 竞品监控, 单链接处理, 自动化流水线, 采集调度, baokuan]
tags: [自媒体, 爆款监控, 采集调度, 飞书, 自动化, cli]
license: MIT
compatible_with: Open Design v0.6+
---

## 何时用这个 skill

当你(或客户的 AI 智能体)需要驱动自媒体爆款监控系统采集 / 处理内容时用它。这个 skill 把桌面端提供的原子 `od baokuan` 命令编排成完整工作流:一次性采集、单链接完整处理、竞品监控,以及**定时全自动运行**。

**核心原则**:桌面端只提供原子能力(`od baokuan` 命令),工作流由你(智能体)编排。所有结果自动沉淀到客户飞书数据中心;核心业务不依赖本 skill——即便不用智能体,直接用系统 cron 调 `od` 命令也能全自动跑(符合客户「脱离总控独立运行」要求)。

## 前置

- 客户已在桌面端「账号」页连接好飞书数据中心(建好 10 张表)。
- 客户已在飞书「监控配置库」配好要监控的关键词 / 竞品账号(或用 `od monitor add` 加)。
- `od` 命令可用(桌面端装好后在 PATH,或用完整路径)。

## 原子命令速查

| 命令 | 作用 | 写哪些飞书表 |
|---|---|---|
| `od baokuan collect --keyword <kw>` | 关键词采集评分(快,radar 模式) | 原始库①、选题池② |
| `od baokuan scheduled` | 读监控配置库所有启用项,批量跑完整链路 | ①②③④⑤ |
| `od baokuan account --name <账号> --window 7d` | 竞品账号采集 | ①②③④⑤ |
| `od baokuan link <url>` | 单链接完整链路 | ①②③④⑤ |
| `od baokuan regenerate` | 处理飞书标「重新生成」的成品 | ④ |
| `od monitor add / list / rm` | 增删改监控配置 | 监控配置库⑥ |
| `od monitor config` | 看 / 改系统全局参数(阈值 / 频率 / 模型) | 系统配置表⑨ |
| `od baokuan cover analyze/gen/rerender` | 类似封面:参考图解析 / 生成 / 改标题重排版 | ④(--record-id 时传附件) |

所有命令加 `--json` 得机器可读输出。

## 工作流

### 1. 一次性采集一个关键词(出选题)
```bash
od baokuan collect --keyword "男性情感成长" --platforms 抖音,小红书 --pages 2 --json
```
→ 采集评分,选题写飞书选题池②,秒级返回候选。客户在飞书选题池看结果。适合高频轮询。

### 2. 单链接完整处理(客户丢一条链接)
```bash
od baokuan link "https://www.douyin.com/video/xxxx" --json
```
→ 采集 → ASR / 文案提取 → 爆点拆解 → 素材召回 → 生成口播脚本 → 写复盘占位,全链路写飞书③④⑤。客户在飞书成品审核库看脚本。

### 3. 竞品账号监控
```bash
od baokuan account --name "某某情感博主" --window 7d --platforms 抖音 --json
```
→ 采集该账号近 7 天作品,完整链路处理。`--window` 取 1d/7d/30d/180d。

### 4. 定时全自动运行(客户核心需求)
先在飞书「监控配置库」配好关键词 / 竞品(或 `od monitor add --keyword "男性情感" --platforms 抖音,小红书`),然后**定时调 `od baokuan scheduled`**——它读监控配置库里所有「是否启用=true」的项,逐个跑完整链路。

**用系统 cron(macOS / Linux):**
```bash
# 每 2 小时跑一轮(读监控配置库所有启用项)
0 */2 * * * /path/to/od baokuan scheduled >> ~/baokuan.log 2>&1
```

**用 AI 智能体(Hermes / Claude 等):**
让智能体按节奏执行,并把 `--json` 输出解析后用大白话汇报:
- 定时调 `od baokuan scheduled` 采集 + 生成脚本
- 调 `od baokuan regenerate` 处理飞书里客户标记「重新生成」的成品
- 汇报"今天采了多少爆款、生成了几条脚本、有没有同步失败"

### 5. 类似封面生成(客户给参考封面)
```bash
# 参考封面 → 同类视觉语言新封面(抖音竖版+B站横版),中文标题程序叠字 100% 不错字
od baokuan cover gen --title "月薪3000的直男,相亲现场有多惨?" --ref /path/参考封面.jpg \
  --platforms douyin,bilibili --record-id <审核库record_id> --json
# 客户只想改标题:不重出背景(不花图像模型钱),秒出新版本
od baokuan cover rerender --bg <上一步的 *_bg.png> --title "新标题" --json
```
`--record-id` 传审核库成品记录时,成品图自动传到该记录「封面成品」附件。风格解析:客户 ARK
开通任一 doubao vision 模型后自动升级为结构化视觉解析;未开通时用参考图直接条件生成+主色提取。

### 6. 处理飞书「重新生成」
客户在飞书成品审核库把某条状态改成「重新生成」后:
```bash
od baokuan regenerate --json
```
→ 系统生成新版本、保留旧版。可挂进定时任务一起跑。

## 注意

- `scheduled / account / link` 走**完整链路**,慢(含 ASR + LLM,可能出图),单次几分钟正常,别设太短的定时间隔;`collect` 是 radar 快采,只出选题不生成脚本,适合高频。
- 所有失败都会在返回 JSON 里带原因(`feishu_synced` / `error`),智能体应检查并汇报,不要静默。
- 检测频率 / 各爆款阈值 / 默认模型都在飞书系统配置表⑨,客户可 `od monitor config` 或直接在飞书改,下次跑生效。
