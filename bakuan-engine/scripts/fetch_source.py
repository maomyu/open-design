"""按链接取单条原素材(轻量,不入库不拆解)——给创作台「取原素材」按钮用。

用法: python -m scripts.fetch_source <url>
输出: JSON {"text": 原文案, "images": [原图直链...], "title": 标题} 或 {"error": ...}

解析/级联取详情逻辑与 pipeline.run_single_link 同源(detect_platform + note id +
fetch_detail 级联);小红书图文原图取 images_list 大图直链(与 radar 采集口径一致)。
"""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import parse_qs, urlparse


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少 url"}, ensure_ascii=False))
        return
    url = sys.argv[1].strip()
    from src.adapters.tikhub_client import TikHubClient, detect_platform

    platform = detect_platform(url)
    if not platform:
        print(json.dumps({"error": f"无法识别平台:{url}"}, ensure_ascii=False))
        return
    xsec_token = (parse_qs(urlparse(url).query).get("xsec_token") or [""])[0]
    path = url.split("?")[0].rstrip("/")
    m = re.search(r"/(?:video|short-video|note|explore|s)/([A-Za-z0-9_-]+)", path)
    aid = m.group(1) if m else path.split("/")[-1]

    tik = TikHubClient()
    item = tik.fetch_detail(platform, aid, xsec_token=xsec_token)
    if not item:
        print(json.dumps({"error": "取不到本条(笔记可能已删/链接不完整;可换带 xsec_token 的完整分享链接)"}, ensure_ascii=False))
        return

    from src.adapters import normalize

    rc = normalize.normalize(platform, item)
    raw = rc.raw if isinstance(getattr(rc, "raw", None), dict) else {}
    images: list[str] = []
    for it in raw.get("images_list") or []:
        if isinstance(it, dict):
            u = it.get("url_size_large") or it.get("url") or it.get("original")
            if u:
                images.append(u)
    text = (raw.get("desc") or rc.title or "").strip()
    print(json.dumps({"title": rc.title, "text": text, "images": images}, ensure_ascii=False))


if __name__ == "__main__":
    main()
