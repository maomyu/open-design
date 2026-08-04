"""抖音/快手/小红书 视频链接 → 可下载直链(给"提取文案仿写"下原视频用)。

为什么用 TikHub 解析下载:抖音等平台的下载接口硬性要登录态 cookie,yt-dlp 匿名下不了;
TikHub 官方接口给个视频链接就返回详情里的 play_addr 直链(无需用户登录),最稳。
(注:这是「下载单条视频做仿写」用途;真抓爆款的选题采集现也走 TikHub 直采。)
各平台详情端点差异见 tikhub_client._PLAT;小红书视频用 app_v2/get_video_note_detail。

用法: python resolve_video_url.py --url "<视频链接>"
输出一行 JSON: {"mediaUrl":..,"referer":..,"platform":..,"title":..} 或 {"error":..}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import settings as _settings  # noqa: E402,F401  载入 .env(TIKHUB_API_KEY)
from src.adapters import normalize  # noqa: E402
from src.adapters.tikhub_client import TikHubClient, detect_platform, expand_share_url  # noqa: E402

# 各平台落地页里视频/笔记 id 的取法(与 pipeline 的解析口径一致)。
_ID_RE = re.compile(r"/(?:video|short-video|note|explore|discovery/item|photo|s)/([A-Za-z0-9_-]+)")
# 平台落地页 referer(下载 CDN 直链时带上,过反盗链)。
_REFERER = {
    "douyin": "https://www.douyin.com/",
    "kuaishou": "https://www.kuaishou.com/",
    "xiaohongshu": "https://www.xiaohongshu.com/",
    "bilibili": "https://www.bilibili.com/",
}


def _extract_media(det: dict) -> str:
    # 抖音:video.play_addr.url_list
    for path in (("video", "play_addr"), ("video", "download_addr"), ("video", "play_addr_h264")):
        node: object = det
        for p in path:
            node = node.get(p) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, dict):
            ul = node.get("url_list") or node.get("UrlList")
            if ul:
                return ul[0]
    # 快手:photo.mainMvUrls[0].url(web/fetch_one_video_v2 结构;2026-07-15 实测)
    photo = det.get("photo") if isinstance(det, dict) else None
    if isinstance(photo, dict):
        for k in ("mainMvUrls", "mvUrls"):
            arr = photo.get(k)
            if isinstance(arr, list) and arr and isinstance(arr[0], dict) and arr[0].get("url"):
                return arr[0]["url"]
    # 小红书:video_info_v2.media.stream.{h264,h265}[0].master_url(app_v2/get_video_note_detail)。
    vinfo = det.get("video_info_v2") if isinstance(det, dict) else None
    stream = ((vinfo or {}).get("media") or {}).get("stream") if isinstance(vinfo, dict) else None
    if isinstance(stream, dict):
        for codec in ("h264", "h265", "h266"):
            arr = stream.get(codec)
            if isinstance(arr, list) and arr and isinstance(arr[0], dict):
                mu = arr[0].get("master_url") or (arr[0].get("backup_urls") or [None])[0]
                if mu:
                    return mu
    return normalize._deep_find_url(det) or ""


def _extract_title(det: dict) -> str:
    # 抖音/通用顶层 desc/title/caption;快手标题在 photo.caption。
    for k in ("desc", "title", "caption"):
        v = det.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:60]
    photo = det.get("photo") if isinstance(det, dict) else None
    if isinstance(photo, dict) and isinstance(photo.get("caption"), str):
        return photo["caption"].strip()[:60]
    return ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    url = ap.parse_args().url.strip()
    url = expand_share_url(url)   # 手机短分享链(v.douyin.com/xxx 等)先展开,短码不是视频 ID

    plat = detect_platform(url)
    if not plat:
        print(json.dumps({"error": "无法识别平台(仅支持抖音/快手/小红书/B站)"}, ensure_ascii=False))
        return
    m = _ID_RE.search(url)
    if not m:
        print(json.dumps({"error": "链接里没解析到视频 id"}, ensure_ascii=False))
        return
    vid = m.group(1)
    try:
        det = TikHubClient().fetch_detail(plat, vid)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"TikHub 详情获取失败:{e}"}, ensure_ascii=False))
        return
    if not isinstance(det, dict) or not det:
        print(json.dumps({"error": "TikHub 未返回视频详情(可能链接失效/私密)"}, ensure_ascii=False))
        return
    media = _extract_media(det)
    if not media:
        print(json.dumps({"error": "详情里没有可下载直链(可能是图文/直播)"}, ensure_ascii=False))
        return
    title = _extract_title(det)
    print(json.dumps(
        {"mediaUrl": media, "referer": _REFERER.get(plat, url), "platform": plat, "title": title},
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
