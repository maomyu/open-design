"""B站视频「存草稿」全自动:绕开网页上传器,用登录 cookie 直连 upos 上传 API + draft/add。

为什么这么做:B站 网页投稿页的上传器(input[name=buploader])拒绝程序化塞文件(Vue 响应式会把
CDP setFiles 塞进去的文件抹掉),抖音/快手/小红书那套「注入网页表单」对 B站 无效。所以改成服务端
用 cookie 直接走 B站 的 upos 分片上传协议(和 biliup 一样),上传完调 draft/add 建**草稿**(非投稿,
契合"存草稿人工发"铁律)。

★关键坑:draft/add 的 video 对象必须带真实 cid,而 cid == preupload 返回的 biz_id(用 0 会 -500)。

用法:python bilibili_upload.py --video <本机mp4> --title <标题> --desc <简介> --tags "a,b" \
        --cookie-file <Netscape cookie 文件> [--cover <本机图>] [--tid 230]
输出一行 JSON:{"ok":true,"draft_id":..} 或 {"error":".."}。
"""
from __future__ import annotations

import argparse
import base64
import json
import os

import requests

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
_MEMBER = "https://member.bilibili.com"


def _load_cookies(path: str) -> dict:
    """从 Netscape cookie 文件读出 B站 鉴权三件套。手动解析(不用 MozillaCookieJar):yt-dlp/浏览器
    导出的 httpOnly 行带 `#HttpOnly_` 前缀,MozillaCookieJar 会当注释跳过→丢掉 SESSDATA(它是 httpOnly)。"""
    cks: dict = {}
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            elif line.startswith("#") or not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) >= 7 and "bilibili" in parts[0]:
                cks[parts[5]] = parts[6]
    missing = [k for k in ("SESSDATA", "bili_jct", "DedeUserID") if not cks.get(k)]
    if missing:
        raise RuntimeError("cookie 缺少 " + ",".join(missing) + "(B站没登录或登录态失效)")
    return cks


def _session(cks: dict) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": _UA, "Referer": _MEMBER + "/platform/upload/video/frame",
                      "Origin": _MEMBER})
    for k in ("SESSDATA", "bili_jct", "DedeUserID"):
        s.cookies.set(k, cks[k])
    return s


def _upload(s: requests.Session, video: str) -> tuple[str, int]:
    """upos 分片上传,返回 (filename, cid)。cid 就是 preupload 的 biz_id。"""
    size = os.path.getsize(video)
    name = os.path.basename(video)
    pre = s.get(_MEMBER + "/preupload", params={
        "name": name, "size": size, "r": "upos", "profile": "ugcupos/bup", "ssl": "0",
        "version": "2.14.0.0", "build": "2140000", "upcdn": "bda2", "probe_version": "20221109",
    }, timeout=30).json()
    if pre.get("OK") != 1:
        raise RuntimeError("preupload 失败(登录态失效/风控):" + str(pre)[:120])
    upos_uri = pre["upos_uri"].replace("upos://", "")
    url = f"https:{pre['endpoint']}/{upos_uri}"
    auth = {"X-Upos-Auth": pre["auth"], "User-Agent": _UA}
    biz_id = pre["biz_id"]  # ← 这就是 draft/add 要的 cid
    chunk_size = pre["chunk_size"]

    init = s.post(f"{url}?uploads&output=json", headers=auth, timeout=30).json()
    upload_id = init["upload_id"]
    key = init["key"]

    with open(video, "rb") as fh:
        data = fh.read()
    chunks = (size + chunk_size - 1) // chunk_size
    parts = []
    for i in range(chunks):
        a = i * chunk_size
        b = min(a + chunk_size, size)
        s.put(url, params={"partNumber": i + 1, "uploadId": upload_id, "chunk": i,
                           "chunks": chunks, "size": b - a, "start": a, "end": b, "total": size},
              data=data[a:b], headers=auth, timeout=300)
        parts.append({"partNumber": i + 1, "eTag": "etag"})
    s.post(f"{url}?output=json&name={name}&profile=ugcupos/bup&uploadId={upload_id}&biz_id={biz_id}",
           json={"parts": parts}, headers=auth, timeout=120)
    filename = key.lstrip("/").rsplit(".", 1)[0]
    return filename, biz_id


def _upload_cover(s: requests.Session, csrf: str, cover_path: str) -> str:
    """封面图 → B站图床,返回封面 URL。失败返回 ""(不阻断存草稿)。cover/up 收 base64 data url。"""
    try:
        ext = os.path.splitext(cover_path)[1].lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        with open(cover_path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        r = s.post(_MEMBER + "/x/vu/web/cover/up",
                   data={"cover": f"data:{mime};base64,{b64}", "csrf": csrf}, timeout=40).json()
        if r.get("code") == 0:
            return (r.get("data") or {}).get("url") or ""
    except Exception:  # noqa: BLE001
        pass
    return ""


def _add_draft(s: requests.Session, csrf: str, filename: str, cid: int,
               title: str, desc: str, tags: str, tid: int, cover: str = "") -> dict:
    body = {
        "videos": [{"filename": filename, "title": title[:80] or "P1", "desc": "",
                    "cid": cid, "is_4k": False, "is_8k": False, "is_hdr": False}],
        "cover": cover, "cover43": "", "ai_cover": 0, "is_ab_cover": 0, "ab_cover_info": None,
        "title": title[:80] or "未命名", "copyright": 1, "creation_statement_id": -1,
        "tid": tid, "tag": tags or "口播", "desc": desc, "recreate": 0, "dynamic": "",
        "season_id": None, "no_disturbance": 0, "is_only_self": 0, "space_hidden": 2,
        "watermark": {"state": 1}, "subtitle": {"open": 0, "lan": ""}, "no_reprint": 0,
        "dolby": 0, "lossless_music": 0, "up_selection_reply": False,
        "up_close_reply": False, "up_close_danmu": False, "csrf": csrf,
    }
    return s.post(_MEMBER + "/x/vupre/web/draft/add", params={"csrf": csrf},
                  json=body, timeout=30).json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--cookie-file", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--desc", default="")
    ap.add_argument("--tags", default="")
    ap.add_argument("--cover", default="")  # 用户在发布页上传的封面图本机路径(可选)
    ap.add_argument("--tid", type=int, default=230)  # 230=有效分区;用户可在草稿箱改
    a = ap.parse_args()
    try:
        if not os.path.exists(a.video):
            print(json.dumps({"error": "视频文件不存在:" + a.video}, ensure_ascii=False)); return
        cks = _load_cookies(a.cookie_file)
        s = _session(cks)
        filename, cid = _upload(s, a.video)
        cover = _upload_cover(s, cks["bili_jct"], a.cover) if (a.cover and os.path.exists(a.cover)) else ""
        res = _add_draft(s, cks["bili_jct"], filename, cid, a.title, a.desc, a.tags, a.tid, cover)
        if res.get("code") == 0:
            data = res.get("data") or {}
            print(json.dumps({"ok": True, "draft_id": data.get("draft_id") or data.get("aid")},
                             ensure_ascii=False))
        else:
            print(json.dumps({"error": f"建草稿失败(code={res.get('code')}):{res.get('message')}"},
                             ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "B站存草稿失败:" + str(e)[:150]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
