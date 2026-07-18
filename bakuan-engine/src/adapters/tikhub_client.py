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
            items = self._douyin_search_paged(keyword, count=count, time_window=time_window)
            # 【采集端保底】窄时间窗(1d/7d)在搜索侧就可能归零——爆款多为存量内容,冷词近一周
            # 常无高互动新作;候选 0 条时降档阶梯"无米下锅",用户看到的就是"筛不到爆款"。
            # 首搜不足 5 条自动放宽到 180 天档重搜合并去重;精确时间窗由 criteria 按发布时间再筛
            # (放宽只是服务端粗筛,不污染规则语义,见 _douyin_publish_time 注释)。
            if len(items) < min(count, 5) and self._douyin_publish_time(time_window) in ("1", "7"):
                logger.info(f"[采集保底] 抖音窄窗({time_window})仅 {len(items)} 条,放宽到 180 天档补采")
                _dy_id = lambda it: str((it.get("aweme_info") or it).get("aweme_id") or id(it))
                have = {_dy_id(it) for it in items}
                for it in self._douyin_search_paged(keyword, count=count, time_window="180d"):
                    if _dy_id(it) not in have:
                        items.append(it)
                        have.add(_dy_id(it))
            return items[:count]
        cfg = _PLAT[platform]
        if cfg["method"] == "POST":
            data = self._call("POST", cfg["search"], body=cfg["body"](keyword, count))
        else:
            params = cfg["params"](keyword, count)
            if platform == "xiaohongshu" and note_type is not None:
                params["note_type"] = note_type   # 覆盖默认 0(综合)→ 只采图文/视频
            data = self._call("GET", cfg["search"], params=params)
        items = _extract_items(data, cfg["list"], cfg.get("item_key"))
        # 小红书 note_type 只是软过滤(偶有漏网),这里再按 type 硬过滤,保证「只出图文/只出视频」。
        if platform == "xiaohongshu" and note_type is not None:
            want_video = (note_type == 1)
            items = [it for it in items if _xhs_is_video(it) == want_video]
            # 【采集端保底】指定类型搜索归零(如图文台的冷词首页全是视频笔记)→ 换综合(0)重搜一次,
            # 仍只保留目标类型(note_type 参数是软过滤,综合池里常有漏网的目标类型)。仍为 0 才如实
            # 返回空——上层 count=0 提示用户换词,而不是让"筛选逻辑"背锅。
            if not items:
                logger.info(f"[采集保底] 小红书 note_type={note_type} 归零,按综合重搜过滤目标类型")
                data2 = self._call("GET", cfg["search"], params={**cfg["params"](keyword, count), "note_type": 0})
                items = [it for it in _extract_items(data2, cfg["list"], cfg.get("item_key"))
                         if _xhs_is_video(it) == want_video]
        return items[:count]

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
        推荐流内容往下写飞书)。"""
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
