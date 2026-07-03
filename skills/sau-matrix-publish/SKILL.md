---
name: sau-matrix-publish
description: 用本机已安装的 social-auto-upload(`sau` CLI)把图文/视频发布到抖音、小红书、快手、B站、视频号、YouTube 等平台,做自媒体矩阵分发。当用户要「发到抖音/小红书」「一键多平台发布」「矩阵发布」「把这条内容发出去」「定时发布」,或在一个发布工作流里需要真正把内容推到平台时,使用本技能。优先用 `sau` 命令行,不要自己去操作浏览器或读各平台网页 DOM——逐平台发布、登录态、过反爬这些苦活 sau 已经做好了。
triggers:
  - 发到抖音
  - 发到小红书
  - 一键多平台发布
  - 矩阵发布
  - sau 发布
  - 定时发布
  - 把这条内容发出去
od:
  category: content-creative
---

# 用 sau 做矩阵发布

`social-auto-upload`(命令 `sau`)是本机一个成熟的多平台发布工具,用真实浏览器 + 持久 cookie 把内容推到各平台。你的工作是**编排和调用它**,而不是自己操作浏览器。

## 运行前提

**统一约定:所有内置插件驱动的外部工作台都是 `~/.open-design/workbenches/` 下的一份独立拷贝**(`~` 即 shell 自动展开;如设了环境变量 `OD_WORKBENCH_DIR` 则以它为根)。**别写死别的深路径,也别回头去用原位置的工具——优化都在工作台这份拷贝上做。**

`sau` 工作台 = `~/.open-design/workbenches/social-auto-upload`,在那个目录下用它自带的虚拟环境运行。**所有 sau 命令都用这个前缀**(不需要 `source activate`):

```bash
cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau <平台> <动作> [参数...]
```
(若该目录不存在,如实告诉用户把 social-auto-upload 拷一份到 `~/.open-design/workbenches/` 下,别去别处乱找。)

平台标识:`douyin`(抖音)、`xiaohongshu`(小红书)、`kuaishou`(快手)、`bilibili`(B站)、`tencent`(视频号)、`youtube`。

> **浏览器:用独立的 `Chrome for Testing`,不碰用户日常 Chrome。** 工作台这份 sau 拷贝已把各 uploader 的 `channel="chrome"` 改成 `channel=None`(用 patchright 自带的 Chrome for Testing),这样 `--headed` 登录/发布会弹出一个**独立浏览器窗口**,不跟用户正在跑的 Chrome 冲突(用系统 Chrome 会撞实例、弹不出窗口、报 EPIPE)。这份补丁已经焊死在工作台拷贝里(拷贝没有 .git,不会被 `git pull` 冲掉);万一哪天换了一份没打补丁的 sau,按下面「失败处理」里的一行命令重打一遍。

## 内容形态支持(发之前先确认)

| 平台 | 视频 | 图文 |
|---|---|---|
| 抖音 douyin | ✅ | ✅ |
| 小红书 xiaohongshu | ✅ | ✅ |
| 快手 kuaishou | ✅ | ✅ |
| B站 bilibili | ✅ | ❌ |
| 视频号 tencent | ✅ | ❌ |
| YouTube | ✅ | ❌ |

> 图文只在抖音/小红书/快手 可用。**知乎不在 sau 范围内**(知乎走单独的 HTTP adapter)。

## 标准发布流程(每次发布都按这个走)

1. **先查账号 + 登录态**(发布前**必做**,绝不跳过):
   ```bash
   cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau <平台> check --account <账号名>
   ```
   这一步同时回答两件事:① 这个账号在不在(账号 = cookie 档 `cookies/<平台>_<账号>.json`,不存在=从没登录过);② cookie 还有没有效。
   - 返回 `valid` → 已登录,可以发。
   - 返回 `invalid` 或提示账号/cookie 不存在 → **没登录(或压根没这个账号)**,进第 2 步,**绝不硬发**。

2. **没登录 / 没账号 → 你(智能体)直接运行 login,弹出独立浏览器让用户扫码**(关键,别只把命令贴给用户让他自己跑):
   - 先说一句:「正在弹出 <平台> 登录页,请用 <平台> App 扫码,5 分钟内完成」。
   - 然后**你直接运行**:
     ```bash
     cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau <平台> login --account <账号名> --headed
     ```
   - 这会弹出一个**独立的浏览器窗口**(`Google Chrome for Testing`,和用户日常的 Chrome 互不干扰),里面**直接显示该平台的扫码登录页**。**二维码就在那个浏览器窗口里,不用把它搬到看板上**——用户对着那个窗口扫码即可。
   - 这条命令会**阻塞等用户扫码**,所以用 **Bash 长超时**跑(timeout ≈ `300000` ms / 5 分钟);扫码成功后命令返回、cookie 持久保存。
   - 分工:**弹浏览器由你自动完成**(用户懒得开终端);**扫码是用户的一次性人工动作,你不替他扫**。
   - 返回后回第 1 步再 `check` 一次确认 `valid`,才进发布。命令超时(没在时限内扫)→ 重跑一次 login。
   - **B站(bilibili)例外**:它的 login 走 biliup interactive,可能在这里起不来;若 `sau bilibili login` 报错或卡住,如实告诉用户在本机终端里手动跑 `cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau bilibili login --account <账号名>`。

3. **发布**:
   - **图文**(抖音/小红书/快手):
     ```bash
     cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau <平台> upload-note \
       --account <账号名> --title "<标题>" \
       --images <图1路径> <图2路径> ... \
       --note "<正文>"  或  --notef <正文文件.txt/md> \
       --tags tag1,tag2 \
       [--schedule "2026-06-20 09:00"]   # 可选定时
     ```
   - **视频**(全平台):
     ```bash
     cd ~/.open-design/workbenches/social-auto-upload && ./.venv/bin/sau <平台> upload-video \
       --account <账号名> --file <视频路径> --title "<标题>" \
       --desc "<描述>" --tags tag1,tag2 \
       [--thumbnail <封面路径>] [--schedule "..."]
     ```

4. **多平台分发**:对每个目标平台重复 1-3。各平台标题/标签/正文可按平台调性微调后分别发,不要一份文案硬套所有平台。

5. **回报**:发完把每个平台的结果(成功/失败、是否定时、命令输出关键行)汇总给用户。失败的明确说哪个平台、什么原因。

## 失败处理(重要)

- **命令报错 `Locator... Timeout` / `扫一扫` 找不到 / 选择器超时**:多半是该平台改版导致 sau 的页面选择器过时。**如实告诉用户该平台的 sau 适配可能需要更新**(`cd ~/.open-design/workbenches/social-auto-upload && git pull` 看有没有修复),不要假装发成功了。
- **`Target page/browser has been closed` / `EPIPE` / 浏览器压根没弹出来**:几乎都是 sau 又用回了系统 Chrome(`channel="chrome"`)跟用户正在跑的 Chrome 撞了(`git pull` 之后最常见)。**一键修**——改成用独立的 `Chrome for Testing`(不碰用户的日常 Chrome):
  ```bash
  cd ~/.open-design/workbenches/social-auto-upload && perl -0pi -e 's/channel="chrome"/channel=None/g' uploader/*/main.py
  ```
  改完重跑 login,浏览器就会作为一个独立窗口弹出来。**不需要让用户关掉自己的 Chrome。**
- **登录超时**:用户没在 5 分钟内扫码,重跑 login 让用户尽快扫。
- 任何不确定是否真的发出去的情况,**坦诚说明**,不要谎报成功。

## 边界

- 只发用户自有账号的自有内容;遵守各平台规则;不规避反爬、不碰非公开数据。
- **登录分工**:弹浏览器/二维码这一步**你自动跑**(`sau login --headed`),扫码这一步**用户自己做**——你绝不替用户扫、不伪造登录态、不谎报已登录。
- 图片/视频文件路径要真实存在;发布前确认文件在。
