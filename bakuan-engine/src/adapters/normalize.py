"""多平台异构字段 → 统一标准化记录 + 作品级去重指纹。

对应主链路 步骤2 标准化 与 步骤3 去重。
各平台原始 item 字段名差异大，这里集中做映射；保留原始 JSON 便于算增速与回溯。
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class RawContent:
    """标准化后的一条内容（入库/评分前的中间态）。"""
    content_id: str          # 平台+作品ID，全局唯一
    platform: str
    content_type: str        # 视频 / 图文 / 文章
    title: str = ""
    url: str = ""
    author: str = ""
    author_id: str = ""      # 作者标识(抖音sec_uid/小红书userid)，用于补粉丝数
    author_url: str = ""
    fans: int = 0
    publish_time: int = 0    # 秒级时间戳
    plays: int = 0
    likes: int = 0
    comments: int = 0
    collects: int = 0
    shares: int = 0
    fingerprint: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_fields(self) -> dict[str, Any]:
        return {
            "内容唯一ID": self.content_id, "平台": cn_platform(self.platform),
            "内容类型": self.content_type, "标题": self.title, "原始链接": self.url,
            "作者": self.author, "粉丝数": self.fans,
            "点赞": self.likes, "评论": self.comments,
            "收藏/投币": self.collects, "转发": self.shares, "播放/阅读": self.plays,
            "发布时间": _fmt_time(self.publish_time), "去重指纹": self.fingerprint,
        }


def _fmt_time(ts: int) -> str:
    """unix 秒/毫秒时间戳 → 'YYYY-MM-DD HH:MM:SS'；无效返回空串。"""
    if not ts:
        return ""
    try:
        from datetime import datetime
        if ts > 1e12:      # 毫秒
            ts = ts / 1000
        if ts < 946684800 or ts > 4102444800:   # 2000~2100 之外视为无效
            return ""
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OSError, OverflowError):
        return ""


def _to_int(v: Any) -> int:
    """兼容 '1.2万' / '3000+' / 数字 等。"""
    if isinstance(v, (int, float)):
        return int(v)
    if not v:
        return 0
    s = str(v).strip().replace(",", "").replace("+", "")
    mult = 1
    if s.endswith("万"):
        mult, s = 10_000, s[:-1]
    elif s.endswith("亿"):
        mult, s = 100_000_000, s[:-1]
    m = re.search(r"[\d.]+", s)
    return int(float(m.group()) * mult) if m else 0


def _pick(d: dict, *keys, default=None):
    for k in keys:
        cur = d
        ok = True
        for part in k.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            return cur
    return default


_CN_PLATFORM = {"douyin": "抖音", "xiaohongshu": "小红书", "bilibili": "B站",
                "kuaishou": "快手", "gzh": "公众号", "channels": "视频号"}


def cn_platform(code: str) -> str:
    """平台代号→中文（展示更友好，统一用中文平台名）。"""
    return _CN_PLATFORM.get(code, code)


def _deep_find_str(o, keys: tuple, _min: int = 20) -> str:
    """递归在嵌套结构里找 keys 中任一键、且值是较长字符串（正文/HTML）。找不到返回空。"""
    keyset = set(keys)
    if isinstance(o, dict):
        for k, v in o.items():
            if k in keyset and isinstance(v, str) and len(v.strip()) >= _min:
                return v
        for v in o.values():
            r = _deep_find_str(v, keys, _min)
            if r:
                return r
    elif isinstance(o, list):
        for x in o:
            r = _deep_find_str(x, keys, _min)
            if r:
                return r
    return ""


def _deep_find_url(o) -> str:
    """深挖首个可能是视频直链的 url（play_addr/download_addr/主播放地址下的 url_list）。"""
    if isinstance(o, dict):
        for k in ("play_addr", "download_addr", "main_mv_urls", "playUrl", "photoUrl", "mainMvUrls"):
            v = o.get(k)
            if isinstance(v, dict):
                ul = v.get("url_list") or v.get("UrlList")
                if ul:
                    return ul[0]
            if isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("url"):
                return v[0]["url"]
            if isinstance(v, str) and v.startswith("http"):
                return v
        for v in o.values():
            r = _deep_find_url(v)
            if r:
                return r
    elif isinstance(o, list):
        for x in o:
            r = _deep_find_url(x)
            if r:
                return r
    return ""


def make_fingerprint(platform: str, aweme_id: str, title: str) -> str:
    clean = re.sub(r'[^\w一-龥]', '', title)[:40]
    base = f"{platform}:{aweme_id}:{clean}"
    return hashlib.md5(base.encode("utf-8")).hexdigest()


_URL_TEMPLATES = {
    "douyin":      "https://www.douyin.com/video/{}",
    "xiaohongshu": "https://www.xiaohongshu.com/explore/{}",
    "bilibili":    "https://www.bilibili.com/video/{}",
    "kuaishou":    "https://www.kuaishou.com/short-video/{}",
    "channels":    "",
    "gzh":         "{}",   # 公众号 id 本身就是完整链接
}


def _build_url(platform: str, raw_id: str) -> str:
    tmpl = _URL_TEMPLATES.get(platform, "")
    if not tmpl:
        return ""
    return tmpl.format(raw_id)


# 各平台字段映射：从原始 item 取值的候选路径（按优先级）
_MAP = {
    "douyin": dict(id=("aweme_id",), title=("desc",),
                   author=("author.nickname",), author_id=("author.sec_uid", "author.uid"),
                   fans=("author.follower_count",),
                   likes=("statistics.digg_count",), comments=("statistics.comment_count",),
                   collects=("statistics.collect_count",), shares=("statistics.share_count",),
                   plays=("statistics.play_count",), ctime=("create_time",), ctype="视频"),
    # 小红书 app_v2 搜索返回扁平字段 liked_count/comments_count/collected_count
    "xiaohongshu": dict(id=("id", "note_id"), title=("title", "desc"),
                        author=("user.nickname", "user.name"),
                        author_id=("user.userid", "user.user_id", "user.id"), fans=("user.fans",),
                        likes=("liked_count", "interact_info.liked_count"),
                        comments=("comments_count", "interact_info.comment_count"),
                        collects=("collected_count", "interact_info.collected_count"),
                        shares=("shared_count", "interact_info.share_count"), plays=(),
                        ctime=("timestamp", "time"), ctype="图文"),
    # B站综合搜索返回扁平字段（like/play/review/favorites），非 stat.* 嵌套
    "bilibili": dict(id=("bvid", "aid"), title=("title",),
                     author=("author", "owner.name"), author_id=("mid", "owner.mid"), fans=(),
                     likes=("like", "stat.like"), comments=("review", "stat.reply"),
                     collects=("favorites", "stat.favorite"), shares=("share", "stat.share"),
                     plays=("play", "stat.view"), ctime=("pubdate", "ctime"), ctype="视频"),
    "kuaishou": dict(id=("photo_id", "id"), title=("caption", "desc"),
                     author=("user_name", "author.name"), author_id=("user_id", "author.id"),
                     fans=("author.fan",),
                     likes=("like_count", "realLikeCount"), comments=("comment_count",),
                     collects=("collect_count",), shares=("share_count",),
                     plays=("view_count", "play_count"), ctime=("timestamp",), ctype="视频"),
    # 视频号走极致了 wxvideo：object_id/like_count/fav_count/forward_count/comment_count/title
    "channels": dict(id=("object_id", "id"), title=("title", "desc"),
                     author=("_author", "nickname"), fans=(),
                     likes=("like_count", "fav_count"), comments=("comment_count",),
                     collects=("fav_count",), shares=("forward_count",), plays=(),
                     ctime=("create_time", "createtime"), ctype="视频"),
    # 极致了 kw_search 返回：read(阅读)/praise(点赞)/looking(在看)/title/url/wx_name/publish_time
    "gzh": dict(id=("url", "id"), title=("title",),
                author=("wx_name", "nickname", "account"), fans=(),
                likes=("praise", "like_num", "old_like_num"), comments=(),
                collects=("looking",), shares=(), plays=("read", "read_num"),
                ctime=("publish_time", "post_time", "posttime"), ctype="文章"),
}


_BROWSER_CTYPE = {"gzh": "文章", "xiaohongshu": "图文", "channels": "视频",
                  "douyin": "视频", "bilibili": "视频", "kuaishou": "视频"}


def normalize_browser(platform: str, item: dict[str, Any]) -> RawContent:
    """内置浏览器采集的【统一扁平条目】→ RawContent（绕过 TikHub/极致了 API）。

    浏览器抓到的每条统一成简单字段：title/url/likes/plays/comments/collects/shares/
    fans/author/author_id/publish_time/content_id/content_type。缺失的补默认，
    url 缺失时按平台+id 兜底拼。评分/去重/榜单逻辑与 API 采集完全共用。
    """
    aid = str(item.get("content_id") or item.get("id") or "").strip()
    title = re.sub(r"<[^>]+>", "", str(item.get("title") or item.get("desc") or "")).strip()
    key = aid or make_fingerprint(platform, "", title)[:16]
    rc = RawContent(
        content_id=f"{platform}_{key}",
        platform=platform,
        content_type=str(item.get("content_type") or _BROWSER_CTYPE.get(platform, "视频")),
        title=title,
        url=str(item.get("url") or _build_url(platform, aid)),
        author=str(item.get("author") or ""),
        author_id=str(item.get("author_id") or ""),
        fans=_to_int(item.get("fans")),
        publish_time=_to_int(item.get("publish_time")),
        plays=_to_int(item.get("plays")),
        likes=_to_int(item.get("likes")),
        comments=_to_int(item.get("comments")),
        collects=_to_int(item.get("collects")),
        shares=_to_int(item.get("shares")),
        raw={**item, "_source": "browser"},
    )
    rc.fingerprint = make_fingerprint(platform, key, title)
    return rc


def normalize(platform: str, item: dict[str, Any]) -> RawContent:
    if item.get("__browser__"):
        return normalize_browser(platform, item)
    m = _MAP[platform]
    aid = str(_pick(item, *m["id"], default="") or "")
    title = re.sub(r"<[^>]+>", "", str(_pick(item, *m["title"], default="") or "")).strip()
    rc = RawContent(
        content_id=f"{platform}_{aid}",
        platform=platform,
        content_type=m["ctype"],
        title=title,
        url=str(_pick(item, "share_url", "url", "note_url", "download_url",
                      "short_link", default="") or ""),
        author=str(_pick(item, *m["author"], default="") or ""),
        author_id=str(_pick(item, *m.get("author_id", ()), default="") or ""),
        fans=_to_int(_pick(item, *m["fans"], default=0)),
        publish_time=_to_int(_pick(item, *m["ctime"], default=0)),
        plays=_to_int(_pick(item, *m["plays"], default=0)),
        likes=_to_int(_pick(item, *m["likes"], default=0)),
        comments=_to_int(_pick(item, *m["comments"], default=0)),
        collects=_to_int(_pick(item, *m["collects"], default=0)),
        shares=_to_int(_pick(item, *m["shares"], default=0)),
        raw=item,
    )
    if not rc.url:
        rc.url = _build_url(platform, aid)
    # 视频号:把 decode_key 以 fragment 挂到下载 url 上(#odk=<key>),下载时 daemon 拆出来解密。
    # dajiala 无「按 object_id 反查」,download_url+decode_key 只在采集时有——这样随选题带走,
    # 下载才拿得到解密 key。fragment 不发服务器、不影响 download_url 的抓取。
    if platform == "channels" and rc.url:
        dk = str(item.get("decode_key") or "").strip()
        if dk and "#odk=" not in rc.url:
            rc.url = f"{rc.url}#odk={dk}"
    rc.fingerprint = make_fingerprint(platform, aid, title)
    return rc


def to_dict(rc: RawContent) -> dict:
    return asdict(rc)
