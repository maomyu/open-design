"""秒读一条笔记/问题的评论(结构化 id/author/text),给互动区 AI 拟稿用。

替代内置浏览器抓取评论(慢 15-60s + 切浏览器标签 + 会卡在"打开笔记页")——TikHub 评论接口
只要 note id,~1-2s 就拿到评论树(id/作者/正文,含一层楼中楼),既快又稳、不切标签、不反爬。

用法: python -m scripts.fetch_comments "<笔记URL或note id>" [platform=xiaohongshu]
输出: {"comments":[{"id","author","text"}, ...]} 或 {"error": "..."}
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
    if re.fullmatch(r"[0-9a-zA-Z]+", r):
        return r
    return ""


def _zhihu_id(ref: str) -> str:
    """知乎评论按【回答 id】取(问题页本身没有评论区)。
    /question/{qid}/answer/{aid} 或 /answer/{aid} → aid;只有 /question/{qid} 的链接【返回空】,
    上层据此走"开场评论"(给问题写第一条评论),而不是拿问题 id 去空跑一次接口。"""
    r = (ref or "").strip()
    m = re.search(r"/answer/(\d+)", r)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d+", r):
        return r
    return ""


def _weibo_id(ref: str) -> str:
    """微博评论按 bid62 或 mid 取(接口两种都认)。
    weibo.com/{uid}/{bid62} / weibo.com/detail/{mid} / m.weibo.cn/status/{id} 都能落到 id;
    搜索页 s.weibo.com/weibo?q=#话题# 这类【不是帖子】的链接必须落空,绝不能把 'weibo' 当 id 发出去。"""
    r = (ref or "").strip()
    m = re.search(r"/(?:detail|status)/([0-9A-Za-z]+)", r)
    if m:
        return m.group(1)
    m = re.search(r"weibo\.com/(?:u/)?\d+/([0-9A-Za-z]{6,})", r)
    if m:
        return m.group(1)
    if re.fullmatch(r"[0-9A-Za-z]{6,}", r) and not r.startswith("http"):
        return r
    return ""


def _humanize_error(e: Exception) -> str:
    """把异常翻成人话:tenacity RetryError 只包着真异常,先挖到里层;HTTP 错误带上状态码
    和平台返回的原话——「key 失效」必须一眼看懂(2026-07-23「无法评论」事故:当时用户只能
    看到批量空转,看不到任何原因)。"""
    cause: BaseException = e
    last = getattr(e, "last_attempt", None)  # tenacity.RetryError
    if last is not None:
        try:
            inner = last.exception()
            if inner is not None:
                cause = inner
        except Exception:  # noqa: BLE001
            pass
    resp = getattr(cause, "response", None)
    if resp is not None:
        status = getattr(resp, "status_code", "?")
        msg = ""
        try:
            body = resp.json()
            detail = body.get("detail") if isinstance(body, dict) else None
            if isinstance(detail, dict):
                msg = str(detail.get("message_zh") or detail.get("message") or "")
            elif detail:
                msg = str(detail)
        except Exception:  # noqa: BLE001
            pass
        if status in (401, 403):
            return (f"TikHub key 失效或无权限(HTTP {status})——去「设置」更新 TikHub API key 后重试。"
                    f"{msg[:120]}")
        return f"TikHub 接口报错(HTTP {status}):{msg[:160] or cause}"
    return str(cause)[:200]


def main() -> None:
    argv = [a for a in sys.argv[1:] if a != "--with-note"]
    with_note = "--with-note" in sys.argv
    ref = argv[0] if argv else ""
    platform = (argv[1] if len(argv) > 1 else "xiaohongshu").strip() or "xiaohongshu"
    if platform == "xiaohongshu":
        nid = _note_id(ref)
    elif platform == "zhihu":
        nid = _zhihu_id(ref)
    elif platform == "weibo":
        nid = _weibo_id(ref)
    else:
        nid = (ref or "").strip()
    qid = ""
    if not nid:
        # 知乎只给了问题链接(没有 /answer/{aid})= 这个页面没有评论区可读,不是错误:
        # 如实返回 0 条,上层照常走「开场评论」。报 error 会让整篇被跳过。
        m = re.search(r"/question/(\d+)", ref or "") if platform == "zhihu" else None
        if not m:
            print(json.dumps({"error": f"识别不出 note id:{ref}"}, ensure_ascii=False))
            return
        qid = m.group(1)

    try:
        from src.adapters.tikhub_client import TikHubClient

        client = TikHubClient()
        comments = client.fetch_comments_structured(platform, nid, count=40) if nid else []
        out: dict = {"comments": comments}
        if with_note:
            # 正文是【给 AI 的上下文加成】,不是主产物:多花一次接口调用,失败也只当没有,
            # 绝不能让它把已经拿到的评论一起带走(评论才是这个脚本的交付物)。
            try:
                brief = (client.fetch_note_brief("zhihu", qid, zhihu_question=True) if qid
                         else client.fetch_note_brief(platform, nid))
                if brief:
                    out["note"] = brief
            except Exception:  # noqa: BLE001
                pass
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"取评论失败:{_humanize_error(e)}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
