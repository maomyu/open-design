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

    # 知乎/微博走【各自的详情接口】取正文,不走 detect_platform + fetch_detail 那条级联:
    #   ① 这两家没进 _URL_PATTERNS(故意的,进了会污染 fetch_detail 等其它调用方);
    #   ② 它们没有"原图直链/媒体直链"这类东西,要的就是标题 + 正文;
    #   ③ 按网页抓正文会撞反爬(知乎尤其),接口路径已在互动区的 withNote 上验证过。
    # id 抽取【复用 fetch_comments 那一套】,免得两处规则各写各的、慢慢漂移。
    if re.search(r"zhihu\.com", url, re.I) or re.search(r"weibo\.(com|cn)", url, re.I):
        from scripts.fetch_comments import _weibo_id, _zhihu_id

        tik = TikHubClient()
        if re.search(r"zhihu\.com", url, re.I):
            answer_id = _zhihu_id(url)
            question = re.search(r"/question/(\d+)", url)
            if answer_id:
                brief = tik.fetch_note_brief("zhihu", answer_id)
            elif question:
                # 只有问题链接:取问题标题+描述当素材(能写,但不是某个具体回答的正文)
                brief = tik.fetch_note_brief("zhihu", question.group(1), zhihu_question=True)
            else:
                print(json.dumps({"error": f"识别不出知乎内容 id:{url}"}, ensure_ascii=False))
                return
        else:
            post_id = _weibo_id(url)
            if not post_id:
                print(json.dumps({"error": f"识别不出微博帖子 id(话题/搜索页不是帖子):{url}"}, ensure_ascii=False))
                return
            brief = tik.fetch_note_brief("weibo", post_id)
        if not brief:
            print(json.dumps({"error": "取不到本条正文(内容可能已删,或链接不是一条具体内容)"}, ensure_ascii=False))
            return
        print(json.dumps(
            {"title": brief.get("title", ""), "text": brief.get("text", ""), "images": []},
            ensure_ascii=False,
        ))
        return

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
    # 视频直链(抖音/快手/B站/小红书视频):深挖 play_addr/download_addr 拿真实媒体 url,
    # 供创作台「取原素材」下载原视频(2026-07-18 用户拍板)。referer 用原文链接。
    media_url = normalize._deep_find_url(raw) if hasattr(normalize, "_deep_find_url") else ""
    print(json.dumps(
        {"title": rc.title, "text": text, "images": images, "mediaUrl": media_url, "referer": url},
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
