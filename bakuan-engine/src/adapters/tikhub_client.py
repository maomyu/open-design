"""TikHub 采集适配器（主通道）—— 端点已按 TikHub OpenAPI 校对（抖音已实盘验证）。

覆盖：抖音 / 小红书 / B站 / 快手 / 视频号；公众号搜索走极致了(dajiala)。
统一 search_keyword() / fetch_comments() / fetch_detail()，各平台差异在 _PLAT 配置。
"""
from __future__ import annotations

import re
from typing import Any, Callable

import requests
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S


def _plain_text(raw: Any) -> str:
    """评论正文转纯文本喂给 AI。微博/知乎的评论是【富文本 HTML】(实测:微博表情是
    `<img alt="[666]">`、@提及是 `<a>`;知乎整段包在 `<p>`、换行是 `<br>`)——直接丢给模型
    会让它照着标签学、甚至把 img src 当内容。表情的 alt 要保留(`[捂脸]` 是真实语气信号)。"""
    s = str(raw or "")
    if "<" not in s:
        return s.strip()
    s = re.sub(r'<img[^>]*\balt="([^"]*)"[^>]*>', r"\1", s)   # 表情图 → [捂脸]
    s = re.sub(r"<br\s*/?>|</p>|</div>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(a, b)
    return re.sub(r"\n{2,}", "\n", s).strip()


def _dig(d: dict, path: str):
    cur = d
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


# 每平台：搜索(方法,路径,body/params 构造)、列表位置候选、单项内层 key、评论(路径,ID参数)、详情
_PLAT: dict[str, dict[str, Any]] = {
    "douyin": {
        "method": "POST",
        "search": "/api/v1/douyin/search/fetch_video_search_v1",
        # publish_time: 0=不限 1=一天 7=一周 180=半年。用 180 拉长窗口，避免某关键词近一周捞不到爆款
        "body": lambda kw, n: {"keyword": kw, "sort_type": "1", "publish_time": "180", "content_type": "1"},
        "list": ["data.data", "data.aweme_list"], "item_key": "aweme_info",
        "comments": ("GET", "/api/v1/douyin/web/fetch_video_comments", "aweme_id"),
        "detail": ("GET", "/api/v1/douyin/web/fetch_one_video", "aweme_id"),
    },
    "xiaohongshu": {
        "method": "GET",
        "search": "/api/v1/xiaohongshu/app_v2/search_notes",
        "params": lambda kw, n: {"keyword": kw, "page": 1, "sort_type": 0, "note_type": 0},
        "list": ["data.data.items", "data.items", "data.data", "data.notes"], "item_key": "note",
        "comments": ("GET", "/api/v1/xiaohongshu/app_v2/get_note_comments", "note_id"),
        "detail": ("GET", "/api/v1/xiaohongshu/app_v2/get_video_note_detail", "note_id"),
    },
    "bilibili": {
        "method": "GET",
        "search": "/api/v1/bilibili/web/fetch_general_search",
        "params": lambda kw, n: {"keyword": kw, "order": "totalrank", "page": 1, "page_size": max(n, 20)},
        "list": ["data.result", "data.data.result", "data.data", "data"], "item_key": None,
        "comments": ("GET", "/api/v1/bilibili/web/fetch_video_comments", "bv_id"),
        "detail": ("GET", "/api/v1/bilibili/web/fetch_video_detail", "bv_id"),
    },
    "kuaishou": {
        "method": "GET",
        "search": "/api/v1/kuaishou/app/search_video_v2",
        "params": lambda kw, n: {"keyword": kw, "pcursor": ""},
        "list": ["data.mixFeeds", "data.feeds", "data.data.feeds", "data.data"], "item_key": "feed",
        "comments": ("GET", "/api/v1/kuaishou/web/fetch_one_video_comment", "photo_id"),
        # 2026-07-15 实测:app/fetch_one_video 端点【超时】(下载失败根因);web/fetch_one_video_v2
        # 快(~2.7s)且返回 photo.mainMvUrls 直链。详情/下载统一走 v2。
        "detail": ("GET", "/api/v1/kuaishou/web/fetch_one_video_v2", "photo_id"),
    },
    "channels": {
        "method": "POST",
        "search": "/api/v1/wechat_search/v2/fetch_search_videos",
        "body": lambda kw, n: {"keyword": kw, "sort": "0", "publish_time": "0", "raw": True},
        "list": ["data.data", "data.items", "data.videos", "data.result", "data"], "item_key": None,
        "comments": ("GET", "/api/v1/wechat_channels/v2/fetch_video_comments", "id"),
        "detail": ("", "", "id"),
    },
    # 知乎/微博【只接评论】:这两家的选题(热榜/搜索)走 daemon 侧的 TS TikHub 客户端,引擎不重复实现,
    # 所以 search 留空(调 search_keyword 会明确报错,不会 KeyError 得莫名其妙)。
    "zhihu": {
        "method": "GET", "search": None, "list": [], "item_key": None,
        # 评论按【回答 id】取(2026-07-25 实测:传问题 id 返回 0 条——知乎问题页本身几乎没人评论,
        # 评论区都挂在具体回答下)。所以互动的知乎链接必须是回答页 /question/{qid}/answer/{aid}
        # 或 /answer/{aid};只有问题链接时读到 0 条 → 上层走"开场评论"路径,符合预期。
        "comments": ("GET", "/api/v1/zhihu/web/fetch_comment_v5", "answer_id"),
        "detail": ("", "", "answer_id"),
    },
    "weibo": {
        "method": "GET", "search": None, "list": [], "item_key": None,
        # id 参数【bid62 与 mid 都认】(2026-07-25 实测 RahxgirYh 与 5324506904397429 返回同一批),
        # 所以 weibo.com/{uid}/{bid62} 这种页面链接里的 bid 可以直接用,不必先换算成 mid。
        "comments": ("GET", "/api/v1/weibo/web_v2/fetch_post_comments", "id"),
        "detail": ("", "", "id"),
    },
}

_URL_PATTERNS = [
    ("douyin", re.compile(r"douyin\.com|iesdouyin")),
    ("xiaohongshu", re.compile(r"xiaohongshu\.com|xhslink")),
    ("bilibili", re.compile(r"bilibili\.com|b23\.tv")),
    ("kuaishou", re.compile(r"kuaishou\.com|chenzhongtech")),
    ("channels", re.compile(r"channels\.weixin|finder")),
    ("gzh", re.compile(r"mp\.weixin\.qq\.com")),
]


def detect_platform(url: str) -> str | None:
    for name, pat in _URL_PATTERNS:
        if pat.search(url):
            return name
    return None


class TikHubClient:
    def __init__(self, base: str | None = None, key: str | None = None):
        self.base = (base or S.KEYS.tikhub_base).rstrip("/")
        self.key = key or S.KEYS.tikhub_key
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.key}",
                                     "User-Agent": "zmt-hot-monitor/0.2"})

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=20))
    def _call(self, method: str, path: str, *, params=None, body=None) -> dict:
        url = f"{self.base}{path}"
        if method == "POST":
            r = self.session.post(url, json=body or {}, timeout=40)
        else:
            r = self.session.get(url, params=params or {}, timeout=40)
        r.raise_for_status()
        try:  # 成本台账:每次 TikHub 接口调用记一笔(接口按次计费)
            from src import store as _store
            _store.add_cost("tikhub", 1, detail=path.rsplit("/", 2)[-1][:40])
        except Exception:  # noqa: BLE001
            pass
        return r.json()

    def search_keyword(self, platform: str, keyword: str, *,
                       count: int = 20, time_window: str = "7d",
                       note_type: int | None = None) -> list[dict]:
        # 抖音走【真分页】累积到 count(2026-07-14 实测:cursor+backtrace+search_id 可翻页,
        # 单页仅 ~8 条,不翻页选不出稀有爆款如低粉爆款)。其它平台暂用单页(各自返回 8-20 条,
        # 够选题;后续按各自游标 pcursor/page 补分页)。
        # note_type 仅小红书用:0 综合 / 1 视频 / 2 图文——图文笔记台采图文(2),短视频台采视频(1)。
        if platform == "douyin":
            return self._douyin_search_paged(keyword, count=count, time_window=time_window)
        if platform == "xiaohongshu":
            # 小红书【真翻页】累积:原来只取 page=1(~20 条混合),视频形态硬过滤后常剩个位数甚至 0——
            # 这就是"小红书视频爆款这么少/太冷门"的根因。改成按 page 翻页凑够 count(视频稀疏就多翻
            # 几页),保底不空手。
            return self._xhs_search_paged(keyword, count=count, note_type=note_type)
        cfg = _PLAT[platform]
        if not cfg.get("search"):
            raise ValueError(f"{platform} 在引擎里只接了评论,没有搜索端点(选题走 daemon 侧 TikHub 客户端)")
        if cfg["method"] == "POST":
            data = self._call("POST", cfg["search"], body=cfg["body"](keyword, count))
        else:
            params = cfg["params"](keyword, count)
            data = self._call("GET", cfg["search"], params=params)
        items = _extract_items(data, cfg["list"], cfg.get("item_key"))
        return items[:count]

    def _xhs_search_paged(self, keyword: str, *, count: int,
                          note_type: int | None = None) -> list[dict]:
        """小红书按 page 真翻页累积,过滤后跨页去重到 count。note_type: 1 视频 / 2 图文 / None 综合。
        视频比图文稀疏,给视频更多翻页预算;翻页没带来新内容(游标到底/失效)即停,不空烧 API。
        这样图文/视频两种形态都能凑够足量候选,不再"只有个位数"。"""
        cfg = _PLAT["xiaohongshu"]
        want_video = (note_type == 1) if note_type is not None else None
        seen: set[str] = set()
        out: list[dict] = []
        max_pages = 12 if want_video else 8   # 视频稀疏 → 多翻几页保底;图文足量,少翻即可
        for page in range(1, max_pages + 1):
            params = dict(cfg["params"](keyword, count))
            params["page"] = page
            if note_type is not None:
                params["note_type"] = note_type   # 软过滤:让服务端先偏向图文/视频
            try:
                data = self._call("GET", cfg["search"], params=params)
            except Exception:
                break   # 某页失败:用已累积的,不整体失败
            items = _extract_items(data, cfg["list"], cfg.get("item_key"))
            if not items:
                break   # 没有更多页了
            page_new = 0
            for it in items:
                nc = it.get("note_card") if isinstance(it.get("note_card"), dict) else {}
                nid = str(it.get("id") or it.get("note_id")
                          or nc.get("note_id") or nc.get("id") or "").strip()
                if nid:
                    if nid in seen:
                        continue   # 跨页重复
                    seen.add(nid)
                page_new += 1
                # 硬过滤(note_type 软过滤偶有漏网):保证「只出图文/只出视频」。
                if want_video is not None and _xhs_is_video(it) != want_video:
                    continue
                out.append(it)
            if page_new == 0 or len(out) >= count:
                break   # 翻页没带来新内容(到底/游标失效)或已够数
        return out[:count]

    @staticmethod
    def _douyin_publish_time(time_window: str | None) -> str:
        """app 时间窗 key → 抖音搜索 publish_time 档(API 只有 0/1/7/180)。
        30d/90d/180d/365d 统一用最长档 180 做服务端粗筛,精确时间窗由 criteria 按 create_time 再筛。"""
        tw = (time_window or "").strip()
        if not tw or tw == "all":
            return "0"
        if tw == "1d":
            return "1"
        if tw == "7d":
            return "7"
        return "180"

    def _douyin_search_paged(self, keyword: str, *, count: int = 30,
                             time_window: str = "180d", sort_type: str = "1") -> list[dict]:
        """抖音视频搜索翻页累积。sort_type: 0综合/1最多点赞/2最新。翻页三件套
        cursor + backtrace + search_id(=log_pb.impr_id)必须一起带,只带 cursor 会 400。"""
        pt = self._douyin_publish_time(time_window)
        out: list[dict] = []
        seen: set[str] = set()
        cursor, backtrace, search_id = 0, "", ""
        for _ in range(8):  # 最多 8 页(~60 条候选),够筛
            body = {"keyword": keyword, "sort_type": sort_type, "publish_time": pt,
                    "content_type": "1", "cursor": cursor,
                    "backtrace": backtrace, "search_id": search_id}
            try:
                data = self._call("POST", _PLAT["douyin"]["search"], body=body)
            except Exception:
                break  # 翻页途中失败:用已累积的,不整体失败
            d = data.get("data", {}) if isinstance(data, dict) else {}
            for it in _extract_items(data, _PLAT["douyin"]["list"], _PLAT["douyin"]["item_key"]):
                aid = it.get("aweme_id")
                if aid and aid not in seen:
                    seen.add(aid)
                    out.append(it)
            if len(out) >= count or not d.get("has_more"):
                break
            cursor = d.get("cursor", cursor)
            backtrace = d.get("backtrace", "") or backtrace
            search_id = (d.get("log_pb") or {}).get("impr_id") or search_id
        return out[:count]

    def fetch_detail(self, platform: str, aweme_id: str, xsec_token: str = "") -> dict:
        if platform in ("xiaohongshu", "xhs"):
            return self._xhs_note_detail(aweme_id, xsec_token)
        cfg = _PLAT[platform]
        m, path, idp = cfg["detail"]
        if not path:
            return {}
        data = self._call(m or "GET", path, params={idp: aweme_id})
        node = data.get("data", data)
        if isinstance(node, list):
            node = node[0] if node else {}
        for k in ("aweme_detail", "aweme_info", "data"):
            if isinstance(node, dict) and isinstance(node.get(k), dict):
                return node[k]
        return node if isinstance(node, dict) else {}

    def _xhs_note_detail(self, note_id: str, xsec_token: str = "") -> dict:
        """小红书按 id 精确取【本条】笔记。

        坑(2026-07-17 实测定位):get_video_note_detail 对【图文】笔记返回的是推荐流
        (别人的笔记)——之前所有小红书都走它,图文单链接内容全串台。图文有专门端点
        get_image_note_detail(实测精确命中本条)。级联策略:
          ① 带 xsec_token(分享长链) → web_v3/fetch_note_detail,两种类型都精确;
          ② app_v2/get_image_note_detail(图文笔记);
          ③ app_v2/get_video_note_detail(视频笔记)。
        每步都校验「返回笔记 id == 请求 id」,命中才采用;全不中返回 {}(绝不拿
        推荐流内容当成本条往下用)。"""
        def _extract(data: dict) -> dict:
            node = data.get("data", data)
            # 服务包裹 {code,success,data:[...]}
            if isinstance(node, dict) and isinstance(node.get("data"), list) and node["data"]:
                node = node["data"][0]
            elif isinstance(node, list):
                node = node[0] if node else {}
            # 图文/视频详情把笔记再包一层 note_list:[note]
            if isinstance(node, dict) and isinstance(node.get("note_list"), list) and node["note_list"]:
                node = node["note_list"][0]
            for k in ("note", "note_card", "data"):
                if isinstance(node, dict) and isinstance(node.get(k), dict):
                    node = node[k]
            return node if isinstance(node, dict) else {}

        def _nid(n: dict) -> str:
            nc = n.get("note_card") if isinstance(n.get("note_card"), dict) else {}
            return str(n.get("note_id") or n.get("id") or nc.get("note_id") or "")

        attempts: list[tuple[str, dict]] = []
        if xsec_token:
            attempts.append(("/api/v1/xiaohongshu/web_v3/fetch_note_detail",
                             {"note_id": note_id, "xsec_token": xsec_token}))
        attempts += [
            ("/api/v1/xiaohongshu/app_v2/get_image_note_detail", {"note_id": note_id}),
            ("/api/v1/xiaohongshu/app_v2/get_video_note_detail", {"note_id": note_id}),
        ]
        for path, params in attempts:
            name = path.rsplit("/", 1)[-1]
            try:
                n = _extract(self._call("GET", path, params=params))
            except Exception as e:  # noqa: BLE001  单端点失败(404/超时)→ 试下一个
                logger.warning(f"小红书详情 {name} 调用失败: {type(e).__name__}: {str(e)[:60]}")
                continue
            rid = _nid(n)
            if n and rid and (note_id in rid or rid in note_id):
                logger.info(f"小红书详情命中本条({name})")
                return n
            logger.warning(f"小红书详情 {name} 返回非本条(得到 {rid or '空'}),试下一端点")
        return {}

    def fetch_account_videos(self, platform: str, ref: str, *, count: int = 20) -> list[dict]:
        """抓指定账号自己的近期作品。ref 可为主页链接或作者ID(抖音sec_uid/B站mid)。

        抖音主页 douyin.com/user/<sec_uid>；B站 space.bilibili.com/<mid>。解析不出ID返回[]，
        由上层降级为关键词搜。
        """
        if platform == "douyin":
            m = re.search(r"/user/([A-Za-z0-9_-]+)", ref)
            sec = m.group(1) if m else (ref if ref.startswith("MS4") else "")
            if not sec:
                return []
            data = self._call("GET", "/api/v1/douyin/web/fetch_user_post_videos",
                              params={"sec_user_id": sec, "count": count})
            return _extract_items(data, ["data.aweme_list", "data.data", "data"], None)
        if platform == "bilibili":
            m = re.search(r"space\.bilibili\.com/(\d+)", ref) or re.search(r"^(\d+)$", ref)
            mid = m.group(1) if m else ""
            if not mid:
                return []
            data = self._call("GET", "/api/v1/bilibili/web/fetch_user_post_videos",
                              params={"uid": mid})
            # TikHub 把 B站原始响应多包了一层 data → 实际列表在 data.data.list.vlist
            return _extract_items(data, ["data.data.list.vlist", "data.list.vlist",
                                         "data.list", "data"], None)
        return []

    def fetch_fans(self, platform: str, author_id: str) -> int:
        """补作者粉丝数（搜索结果不带）。抖音=sec_uid/小红书=userid/B站=mid/快手=user_id。

        B站/快手需按作者ID单独查（relation_stat / user_info）。公众号无粉丝概念（用平均阅读代理，见 dajiala）。
        """
        if not author_id:
            return 0
        try:
            if platform == "douyin":
                data = self._call("GET", "/api/v1/douyin/web/handler_user_profile",
                                  params={"sec_user_id": author_id})
                u = (data.get("data") or {}).get("user") or data.get("data") or {}
                return int(u.get("follower_count") or 0)
            if platform == "xiaohongshu":
                data = self._call("GET", "/api/v1/xiaohongshu/app_v2/get_user_info",
                                  params={"user_id": author_id})
                return _deep_find(data.get("data") or data, "fans")
            if platform == "bilibili":
                data = self._call("GET", "/api/v1/bilibili/web/fetch_user_relation_stat",
                                  params={"uid": author_id})
                return int((data.get("data") or {}).get("follower") or 0)
            if platform == "kuaishou":
                # app 端点可用 numeric user_id 拿到 fan；web 端点会报参数格式错误
                data = self._call("GET", "/api/v1/kuaishou/app/fetch_one_user_v2",
                                  params={"user_id": str(author_id)})
                return _deep_find(data.get("data") or data, "fan")
        except Exception:
            return 0
        return 0

    def fetch_comments(self, platform: str, content_id: str, *, count: int = 50) -> list[str]:
        cfg = _PLAT.get(platform, {})
        c = cfg.get("comments")
        if not c or not c[1]:
            return []
        m, path, idp = c
        aid = content_id.split("_", 1)[-1]
        try:
            data = self._call(m, path, params={idp: aid})
        except Exception:
            return []
        # 各平台评论列表位置差异大：抖音 data.comments；B站 data.data.replies；快手 data.rootComments
        items = _extract_items(
            data, ["data.comments", "data.data.replies", "data.rootComments",
                   "data.data", "data.list", "data"], None)
        out = []
        for c_ in items:
            if not isinstance(c_, dict):
                continue
            # 文本可能在 text / content(字符串) / content.message(B站) / comment
            t = (c_.get("text") or _dig(c_, "content.message")
                 or (c_.get("content") if isinstance(c_.get("content"), str) else None)
                 or c_.get("commentText") or _dig(c_, "comment.text"))
            if t:
                out.append(str(t))
            if len(out) >= count:
                break
        return out

    def fetch_note_brief(self, platform: str, content_id: str, *,
                         xsec_token: str = "", zhihu_question: bool = False) -> dict:
        """取内容本体的【标题 + 正文】,给互动区 AI 当上下文:返回 {"title","text"}。

        原来拟稿只喂了标题(还是从选题池带下来的),AI 只能就着标题泛泛而谈;写「开场评论」时更吃亏
        ——没正文就只能对着标题硬夸,容易写出跟内容对不上的车轱辘话(手动粘的链接连标题都没有,
        gen-opening 直接拒写)。这里按平台取一次正文补上。

        每平台各要一次接口调用(按次计费),所以是【可选】的:调用方(read-comments-fast 的
        withNote)决定要不要。取不到就返回 {},绝不能让它影响评论本身。
        """
        pid = (platform or "").strip()
        if pid in ("xiaohongshu", "xhs"):
            note = self._xhs_note_detail(content_id, xsec_token)
            title = str(note.get("title") or "").strip()
            text = _plain_text(note.get("desc") or note.get("description") or "")
            return {"title": title, "text": text} if (title or text) else {}
        if pid == "zhihu" and zhihu_question:
            # 只有问题链接(没有具体回答)时:问题本身就是全部上下文——「开场评论」正是写给这个问题的,
            # 拿到问题描述后 AI 才不至于只对着标题硬写。
            data = self._call("GET", "/api/v1/zhihu/web/fetch_question_detail",
                              params={"question_id": content_id})
            node = data.get("data") if isinstance(data.get("data"), dict) else {}
            title = str(node.get("title") or "").strip()
            text = _plain_text(node.get("excerpt") or "") or _plain_text(
                _dig(node, "detail") or _dig(node, "description") or "")
            return {"title": title, "text": text} if (title or text) else {}
        if pid == "zhihu":
            data = self._call("GET", "/api/v1/zhihu/web/fetch_answer_detail",
                              params={"answer_id": content_id})
            node = data.get("data") if isinstance(data.get("data"), dict) else {}
            q = node.get("question") if isinstance(node.get("question"), dict) else {}
            # 知乎回答的「标题」其实是问题——回答本身没标题,评论都是冲着问题+这篇回答来的。
            title = str(q.get("title") or "").strip()
            # excerpt 已是纯文本摘要(实测),content 是富文本 HTML;优先 excerpt,不够再退 content。
            text = _plain_text(node.get("excerpt") or "") or _plain_text(node.get("content") or "")
            return {"title": title, "text": text} if (title or text) else {}
        if pid == "weibo":
            data = self._call("GET", "/api/v1/weibo/web_v2/fetch_post_detail",
                              params={"id": content_id, "is_get_long_text": "true"})
            node = data.get("data") if isinstance(data.get("data"), dict) else {}
            if isinstance(node.get("data"), dict):
                node = node["data"]
            lt = node.get("longText") if isinstance(node.get("longText"), dict) else {}
            text = (_plain_text(lt.get("longTextContent") or "")
                    or str(node.get("text_raw") or "").strip()
                    or _plain_text(node.get("text") or ""))
            # 微博没有标题字段:正文首句当标题(上层展示/提示词都需要一个短标题)。
            title = text.split("\n", 1)[0][:40]
            return {"title": title, "text": text} if text else {}
        return {}

    def fetch_comments_structured(
        self, platform: str, content_id: str, *, count: int = 40
    ) -> list[dict]:
        """结构化取评论:返回 [{id, author, text}](含一层楼中楼)。
        用于互动区【秒读评论】——替代内置浏览器抓取(慢+切标签+会卡),接口 ~1-2s 拿到 id/作者/正文,
        既快又稳,还带评论 id/作者(比网页抓的更全)。各平台字段名差异用多候选兜底。"""
        cfg = _PLAT.get(platform, {})
        c = cfg.get("comments")
        if not c or not c[1]:
            return []
        m, path, idp = c
        aid = content_id.split("_", 1)[-1]
        # 读失败必须【抛出去】,绝不许吞成 [](2026-07-23 事故:key 失效被静默成"0 评论",
        # 互动区把每篇都当没人评论、批量直发空转,用户完全看不到真因)。唯一调用方
        # scripts/fetch_comments.py 会接住并转成可读 {"error": ...}。
        data = self._call(m, path, params={idp: aid})
        # 小红书 app_v2 评论在 data.data.comments;微博 web_v2 在 data.data.data(双层 data 里再一层);
        # 知乎 comment_v5 在 data.data(列表)。其余平台各自路径兜底。
        items = _extract_items(
            data, ["data.data.comments", "data.data.data", "data.comments", "data.data.replies",
                   "data.rootComments", "data.data", "data.list", "data"], None)

        def _one(c_: Any) -> dict | None:
            if not isinstance(c_, dict):
                return None
            cid = str(c_.get("id") or c_.get("idstr") or c_.get("cid") or c_.get("rpid")
                      or c_.get("comment_id") or "").strip()
            # 作者容器:小红书/抖音 user、B站 member、知乎 author、微博 user.screen_name。
            u = (c_.get("user") or c_.get("user_info") or c_.get("member")
                 or c_.get("author") or {})
            author = ""
            if isinstance(u, dict):
                author = str(u.get("nickname") or u.get("name") or u.get("uname")
                             or u.get("screen_name") or "").strip()
            t = ((c_.get("content") if isinstance(c_.get("content"), str) else None)
                 or c_.get("text") or _dig(c_, "content.message")
                 or c_.get("commentText") or "")
            t = _plain_text(t)
            if not t:
                return None
            return {"id": cid, "author": author, "text": t}

        out: list[dict] = []
        for c_ in items:
            top = _one(c_)
            if top:
                out.append(top)
            # 楼中楼:小红书 sub_comments、知乎 child_comments、微博 comments(没有楼中楼时是 false/0,
            # 靠 isinstance 挡掉)。
            subs = None
            if isinstance(c_, dict):
                for k in ("sub_comments", "child_comments", "comments"):
                    if isinstance(c_.get(k), list):
                        subs = c_[k]
                        break
            if isinstance(subs, list):
                for s in subs:
                    so = _one(s)
                    if so:
                        out.append(so)
            if len(out) >= count:
                break
        return out[:count]


def _deep_find(o, key: str) -> int:
    """从嵌套结构里递归找某数字字段（如小红书 fans，层级不固定）。"""
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key and isinstance(v, (int, str)):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    pass
            r = _deep_find(v, key)
            if r:
                return r
    elif isinstance(o, list):
        for x in o:
            r = _deep_find(x, key)
            if r:
                return r
    return 0


def _xhs_is_video(item: dict) -> bool:
    """小红书笔记是否视频(用于图文/视频硬过滤)。优先看 type 字段('video'/'normal'),
    兜底看是否带视频信息字段。item 可能是裸 note 或带 note_card 包裹。"""
    if not isinstance(item, dict):
        return False
    nc = item.get("note_card") if isinstance(item.get("note_card"), dict) else {}
    t = str(item.get("type") or nc.get("type") or item.get("note_type") or "").lower()
    if t == "video":
        return True
    if t in ("normal", "图文", "image", "note"):
        return False
    return bool(item.get("video") or item.get("video_info") or nc.get("video"))


def _extract_items(data: dict, list_paths: list[str], item_key: str | None) -> list[dict]:
    """按候选路径取列表，并（如需要）取每项内层 wrapper（如抖音 aweme_info）。"""
    lst = None
    if isinstance(data, dict):
        for p in list_paths:
            v = _dig(data, p)
            if isinstance(v, list):
                lst = v
                break
    if lst is None:
        lst = data if isinstance(data, list) else []
    out = []
    for it in lst:
        if not isinstance(it, dict):
            continue
        inner = it.get(item_key) if item_key and isinstance(it.get(item_key), dict) else it
        out.append(inner)
    return out
