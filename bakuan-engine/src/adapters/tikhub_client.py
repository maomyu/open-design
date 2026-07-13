"""TikHub 采集适配器（主通道）—— 端点已按 TikHub OpenAPI 校对（抖音已实盘验证）。

覆盖：抖音 / 小红书 / B站 / 快手 / 视频号；公众号搜索走极致了(dajiala)。
统一 search_keyword() / fetch_comments() / fetch_detail()，各平台差异在 _PLAT 配置。
"""
from __future__ import annotations

import re
from typing import Any, Callable

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S


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
        "comments": ("GET", "/api/v1/xiaohongshu/app/get_note_comments", "note_id"),
        "detail": ("GET", "/api/v1/xiaohongshu/web/get_note_info_v7", "note_id"),
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
        "detail": ("GET", "/api/v1/kuaishou/app/fetch_one_video", "photo_id"),
    },
    "channels": {
        "method": "POST",
        "search": "/api/v1/wechat_search/v2/fetch_search_videos",
        "body": lambda kw, n: {"keyword": kw, "sort": "0", "publish_time": "0", "raw": True},
        "list": ["data.data", "data.items", "data.videos", "data.result", "data"], "item_key": None,
        "comments": ("GET", "/api/v1/wechat_channels/v2/fetch_video_comments", "id"),
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
        return r.json()

    def search_keyword(self, platform: str, keyword: str, *,
                       count: int = 20, time_window: str = "7d") -> list[dict]:
        cfg = _PLAT[platform]
        if cfg["method"] == "POST":
            data = self._call("POST", cfg["search"], body=cfg["body"](keyword, count))
        else:
            data = self._call("GET", cfg["search"], params=cfg["params"](keyword, count))
        return _extract_items(data, cfg["list"], cfg.get("item_key"))[:count]

    def fetch_detail(self, platform: str, aweme_id: str) -> dict:
        cfg = _PLAT[platform]
        m, path, idp = cfg["detail"]
        if not path:
            return {}
        data = self._call(m or "GET", path, params={idp: aweme_id})
        node = data.get("data", data)
        for k in ("aweme_detail", "aweme_info", "note", "note_card", "data"):
            if isinstance(node, dict) and isinstance(node.get(k), dict):
                return node[k]
        return node if isinstance(node, dict) else {}

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
