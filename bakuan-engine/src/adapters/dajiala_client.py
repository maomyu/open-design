"""极致了 / 大家啦 公众号数据适配器（TikHub 公众号阅读数兜底）。

大家啦(dajiala.com) 擅长公众号阅读/在看/文章数据。此处封装关键词搜文章与文章阅读数补全。
⚠️ 具体端点/参数以极致了后台文档为准，已列入《开发前需确认》；下方为占位。
"""
from __future__ import annotations

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S


class DajialaClient:
    def __init__(self):
        self.base = S.KEYS.dajiala_base.rstrip("/")
        self.key = S.KEYS.dajiala_key

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=20))
    def _post(self, path: str, payload: dict) -> dict:
        payload = {**payload, "key": self.key}
        r = requests.post(f"{self.base}{path}", json=payload, timeout=30)
        r.raise_for_status()
        return r.json()

    def search_articles(self, keyword: str, *, page: int = 1, period: int = 7,
                        sort_type: int = 1) -> list[dict]:
        """按关键词搜公众号文章（大家啦 kw_search，返回含 read/praise/looking）。

        sort_type: 1=按阅读排序 2=按时间；mode:1=标题；period:天数窗口。按条计费 0.02/条。
        """
        data = self._post("/fbmain/monitor/v3/kw_search",
                          {"kw": keyword, "sort_type": sort_type, "mode": 1,
                           "period": period, "page": page, "any_kw": "", "ex_kw": "", "type": 1})
        if isinstance(data, dict):
            for k in ("data", "list", "articles"):
                if isinstance(data.get(k), list):
                    return data[k]
        return data if isinstance(data, list) else []

    def article_stats(self, url: str) -> dict:
        """补全单篇文章阅读/在看/点赞。"""
        return self._post("/fbmain/monitor/v3/article_info", {"url": url})

    def account_followers(self, url: str) -> int:
        """公众号粉丝数（follower_stats，按文章 url 查所属号）。约 0.5 元/次。"""
        try:
            data = self._post("/fbmain/monitor/v3/follower_stats", {"url": url, "verifycode": ""})
            return int(data.get("fans") or 0) if isinstance(data, dict) else 0
        except Exception:
            return 0

    def search_videos(self, keyword: str, *, max_accounts: int = 3) -> list[dict]:
        """关键词搜索视频号（大家啦 wxvideo）。两步：type=4 搜账号 → type=1 取各账号作品。

        为控成本，仅取前 max_accounts 个账号的作品聚合返回；每条作品补上作者昵称。
        """
        acc = self._post("/fbmain/monitor/v3/wxvideo",
                         {"type": 4, "keywords": keyword, "verifycode": ""})
        accounts = acc.get("v2_info_list", []) if isinstance(acc, dict) else []
        videos: list[dict] = []
        for a in accounts[:max_accounts]:
            contact = a.get("contact", {})
            v2_name = contact.get("username", "")
            nickname = contact.get("nickname", "")
            if not v2_name:
                continue
            try:
                r = self._post("/fbmain/monitor/v3/wxvideo",
                               {"type": 1, "v2_name": v2_name, "verifycode": "", "page": 1})
            except Exception:
                continue
            for obj in (r.get("object", []) if isinstance(r, dict) else []):
                obj["_author"] = nickname   # 注入作者昵称供 normalize
                videos.append(obj)
        return videos
