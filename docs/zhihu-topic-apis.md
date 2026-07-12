# 知乎选题接口地图（内置浏览器实测）

> 2026-07-12 用内置浏览器（登录态 webview，账号「是茂宇呀」）同源实测 www.zhihu.com
> 的内部接口，用于知乎选题台的原生数据源。**这些接口都需要登录态 cookie（z_c0
> 等 httpOnly），必须在登录着知乎的 webview 上下文里调——daemon 服务端没有用户
> cookie，走 daemon 会被限流/拦（与 TikHub 那种第三方聚合的架构不同，见文末）。**

只读用途（选题=读热榜/搜索/联想）。切勿高频批量——会触发风控。

---

## ✅ 已接入选题台（2026-07-12）

知乎创作台「选题」页已用这些接口替掉 TikHub-知乎路径（桌面端 + 有知乎账号时）。
最终没走设想的 webview `executeJavaScript`，而是更干净的**主进程会话直取**（无隐藏
webview、无同源导航要求，见下面「架构约束」订正）。

- 用户桥：`packages/host` 的 `browser.sessionFetch`（`hostBrowserSessionFetch` /
  探测 `isOpenDesignHostSessionFetchAvailable`）。
- 桌面端主进程：`apps/desktop/src/main/embedded-browser.ts` 的
  `registerBrowserSessionFetchBridge()`——`session.fromPartition('persist:
  od-browser-zhihu-<账号>').fetch(url)` 带登录 cookie 直取，只读、10s 超时、4MB 上限。
- web 运行时：`apps/web/src/runtime/zhihu-topics.ts`（`fetchZhihuTopics` + 四源
  映射）→ 选题台 `TopicsTab` 的 `nativeFeed` prop（`ZhihuStudioView` 接线，门禁
  `isOpenDesignHostSessionFetchAvailable() && 有知乎账号`；否则回落 TikHub）。
- 四源按钮：热榜 / 实时热搜 / 联想词 / 搜索，结果进现有候选表，可「AI 帮我选题」深挖。
  搜索结果 title/excerpt 带 `<em>` 高亮，映射时剥 HTML；热度（detail_text/hot）在
  数据列优先显示。
- **实测**（账号「是茂宇呀」）：热榜 30 条带热度、联想词「军队文职」10 条真实读者
  搜索词、搜索 19 条、实时热搜 30 条——四源全 200、字段路径全对。
- **CLI 边界**：此路径是桌面本地读用户自己的登录态，CLI/daemon 不可达；智能体要
  知乎选题继续走 TikHub 或后续做会话桥（本期不做）。

---

## 1. 内容热榜（核心选题源）

```
GET https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true
```
返回 `data[]`（实测 ~30 条），每条：
- `target.title` — 问题标题（选题）
- `detail_text` — 热度文案，如「2797 万热度」
- `target.url` — `https://api.zhihu.com/questions/<id>`（换成 www 域即网页链接）
- `target.answer_count` / `follower_count` / `comment_count` — 互动量
- `target.excerpt` — 摘要
- `trend` / `debut` — 趋势/是否新上榜

顶层还有 `fresh_text`、`paging`。

## 2. 实时热搜（搜索热榜）

```
GET https://www.zhihu.com/api/v4/search/hot_search
```
返回 `hot_search_queries[]`：`{query, real_query, hot, label('hot'/...), icon_url, query_id}`。
比内容热榜更"此刻在搜什么"，适合抓突发热点。

## 3. 联想词（⭐ 选题角度金矿）

```
GET https://www.zhihu.com/api/v4/search/suggest?q=<关键词>
```
返回 `suggest[]`（~10 条）：`{query, id, tab_type}`。query 是真实用户搜索短语，
例：q=军队文职 → 「军队文职真的值得考吗 / 亲身经历及感悟 / 机构哪个靠谱 / 怎么
复习备考 / 什么专业热门」。**这些直接就是读者疑问=文章切入角度。**

## 4. 综合搜索

```
GET https://www.zhihu.com/api/v4/search_v3?t=general&q=<关键词>&correction=1&offset=0&limit=20&search_source=Normal
```
返回 `data[]`（20 条），`type` 有 `hot_timing`（相关热点聚合）与 `search_result`（内容）。
search_result 的 `object`：`{title, url, excerpt, voteup_count, comment_count, answer_count,
question, author, content, created_time}`。顶层有 `paging`（可 offset 翻页）、
`related_search_result`（相关搜索词，也可做选题）。

## 5. 问题热榜（按时段）

```
GET https://www.zhihu.com/api/v4/creators/rank/hot?domain=0&period=hour
```
返回 `data[]`（~16 条）：`{question:{title,url,created,id}}`。`period=hour|day`，
`domain` 可按领域过滤。适合"当下值得答的热门问题"。

## 6. 推荐流（选题用途弱，个性化）

```
GET https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=6&desktop=true
```
个性化推荐，因人而异，不适合做通用选题源，仅记录。

---

## 架构约束（建功能时必读）

- **登录态在 webview**：以上接口靠内置浏览器（`persist:od-browser-zhihu-<账号>`
  分区）的 cookie。daemon 无此 cookie。
- 所以知乎原生选题**不能像 TikHub 那样走 daemon**（`/api/media-studio/:platform/
  topics/tikhub-feed`）。三条路：
  1. **webview 侧抓取**：登录着的知乎 webview `executeJavaScript` 同源 fetch，回传选题台。
  2. **cookie 注入 daemon**：从分区取 z_c0 等 cookie 注入 daemon 请求头（更脆、易过期，不推荐）。
  3. ✅ **主进程会话直取（最终采用）**：桌面端主进程 `session.fromPartition(分区).
     fetch(url)` 直接带该分区登录 cookie 请求——无隐藏 webview、无 `executeJavaScript`、
     无同源导航要求。实测主进程 `session.fetch` 带 cookie 即过知乎（四源全 200）。
- 采用路径 3（比 1 更干净）。落地文件见文首「已接入选题台」。
- 路径 3 无同源约束：主进程直接打 `www.zhihu.com` 接口即可，不必先导航 webview 到 www 域。

## 字段速用（选题卡最少需要）

`{ title(问题), heat(detail_text/hot), url, engagement(answer/voteup/comment) }`——
热榜、热搜、联想、搜索四个接口都能凑出这四要素，足够选题台展示与 AI 深挖。
