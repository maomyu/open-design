"""给一条小红书笔记(URL 或裸 note id)现取一个新鲜 xsec_token,拼成能在内置浏览器打开的完整 URL。

用途:旧采集的笔记 URL 缺 xsec_token → 内置浏览器打不开(反爬 300031)→ 互动读评论/回复全废。
互动前用 TikHub 笔记详情接口(get_*_note_detail,只要 note id)取一个新 token,现拼 URL。

用法: python -m scripts.resolve_xhs_token "<笔记URL或note id>"
输出: {"url": "https://www.xiaohongshu.com/explore/<id>?xsec_token=...&xsec_source=pc_search"} 或 {"error": ...}
"""
from __future__ import annotations

import json
import re
import sys


def _note_id(ref: str) -> str:
    r = (ref or "").strip()
    m = re.search(r"/(?:explore|discovery/item|item)/([0-9a-zA-Z]+)", r)
    if m:
        return m.group(1)
    # 裸 id
    if re.fullmatch(r"[0-9a-zA-Z]+", r):
        return r
    return ""


def main() -> None:
    ref = sys.argv[1] if len(sys.argv) > 1 else ""
    nid = _note_id(ref)
    if not nid:
        print(json.dumps({"error": f"识别不出 note id:{ref}"}, ensure_ascii=False))
        return
    try:
        from src.adapters.tikhub_client import TikHubClient

        detail = TikHubClient().fetch_detail("xiaohongshu", nid)
        flat = json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else str(detail)
        # token 可能是 JSON 字段 "xsec_token":"..." 或 URL 参数 xsec_token=...(详情里多为后者,嵌在
        # 分享/feed 链接里)。两种都试,取第一个。
        m = re.search(r'"xsec_token"\s*:\s*"([^"]+)"', flat) or re.search(r'xsec_token=([^"&\s\\]+)', flat)
        tok = m.group(1) if m else ""
        if not tok:
            print(json.dumps({"error": "详情里没取到 xsec_token(笔记可能已删/被限)"}, ensure_ascii=False))
            return
        url = f"https://www.xiaohongshu.com/explore/{nid}?xsec_token={tok}&xsec_source=pc_search"
        print(json.dumps({"url": url}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"取 token 失败:{e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
