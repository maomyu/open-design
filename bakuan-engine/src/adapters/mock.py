"""离线 dry-run 用的假数据：无需任何 Key 即可跑通全链路，验证编排正确性。"""
from __future__ import annotations


def mock_search(platform: str, keyword: str, count: int = 20) -> list[dict]:
    """返回一批贴近真实结构的假内容（各平台字段名对齐 normalize._MAP）。"""
    base = [
        {"aweme_id": f"{platform}001", "desc": f"{keyword}的男生怎么破局",
         "author": {"nickname": "情感老王", "follower_count": 3200},
         "statistics": {"digg_count": 80000, "comment_count": 5000, "collect_count": 30000,
                        "share_count": 8000, "play_count": 600000},
         "create_time": 1720000000, "share_url": "https://v.douyin.com/mock1",
         # 兼容其它平台字段
         "note_id": f"{platform}001", "title": f"{keyword}的男生怎么破局",
         "user": {"nickname": "情感老王", "fans": 3200},
         "interact_info": {"liked_count": 80000, "comment_count": 5000, "collected_count": 30000},
         "stat": {"like": 80000, "reply": 5000, "favorite": 30000, "view": 600000},
         "like_count": 80000, "read_num": 90000, "like_num": 5000},
        {"aweme_id": f"{platform}002", "desc": f"{keyword}其实是心态问题",
         "author": {"nickname": "小账号", "follower_count": 1800},
         "statistics": {"digg_count": 600, "comment_count": 120, "collect_count": 90,
                        "share_count": 20, "play_count": 20000},
         "create_time": 1720500000, "share_url": "https://v.douyin.com/mock2",
         "note_id": f"{platform}002", "title": f"{keyword}其实是心态问题",
         "user": {"nickname": "小账号", "fans": 1800},
         "interact_info": {"liked_count": 600, "comment_count": 120, "collected_count": 90},
         "stat": {"like": 600, "reply": 120, "favorite": 90, "view": 20000},
         "like_count": 600, "read_num": 12000, "like_num": 120},
    ]
    return base[:count]


def mock_account_posts(platform: str, account: str, count: int = 20) -> list[dict]:
    """假的竞品账号近作品（供账号监控链路）。"""
    posts = mock_search(platform, "竞品选题", count)
    for i, p in enumerate(posts):
        p["author"]["nickname"] = account
        p["aweme_id"] = f"{platform}_acc_{i}"
        p["note_id"] = p["aweme_id"]
    return posts


def mock_account_recent_likes(platform: str, account: str) -> list[int]:
    """假的账号近 10 条点赞（供账号异常倍数判定 account_excess）。"""
    return [1200, 900, 1500, 800, 1100, 1300, 700, 1000, 1400, 950]


def mock_comments(platform: str, content_id: str, count: int = 50) -> list[str]:
    return [
        "太真实了，我就是这样", "相亲后没下文怎么办", "这种情况具体怎么解决",
        "能咨询吗怎么收费", "女生回复越来越慢怎么办", "哈哈哈第一",
        "我单身很多年了", "有没有具体方法", "求指导", "怎么联系你",
    ][:count]
