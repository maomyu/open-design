"""内置浏览器采集器：用 agent-browser 打开各平台搜索页、抓取爆款作品，输出统一 collect-file。

绕过 TikHub/极致了 API（省钱 + 绕平台风控）：数据来自你【真实登录】的浏览器会话，
和普通人刷一样，最贴近真实爆款。输出喂给引擎 `--collect-file` 做评分选题。

用法：
  python scripts/browser_collect.py --keyword "相亲" --platforms xiaohongshu,douyin \
      --out /tmp/collect.json [--session baochuang] [--scrolls 6] [--per 20]

- 持久会话 `--session`（默认 baochuang）：登录一次长期有效。
- 某平台若未登录，脚本不会硬爬，会在输出里标 needs_login，并把该平台留空，
  提示你去那个已打开的窗口登录后重跑。
- 每个平台一个提取器 JS（EXTRACTORS），返回统一扁平字段：
  content_id/title/url/likes/comments/collects/plays/author/author_id。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from urllib.parse import quote

SESSION_DEFAULT = "baochuang"

# 各平台搜索页 URL（关键词已 urlencode 占位）
SEARCH_URL = {
    "xiaohongshu": "https://www.xiaohongshu.com/search_result?keyword={kw}",
    "douyin":      "https://www.douyin.com/search/{kw}?type=video",
    "bilibili":    "https://search.bilibili.com/all?keyword={kw}",
    "kuaishou":    "https://www.kuaishou.com/search/video?searchKey={kw}",
}

# 登录墙特征（页面文本/URL 命中即判未登录）
LOGIN_WALL = {
    "xiaohongshu": ["登录后查看", "扫码登录", "手机号登录"],
    "douyin":      ["登录后可查看", "扫码登录", "验证码登录"],
    "bilibili":    [],  # B 站搜索多数免登录
    "kuaishou":    ["登录后", "扫码登录"],
}

# 每平台提取器：在页面里跑，返回 [{统一字段}]。选择器尽量宽松 + 兜底，避免频繁失效。
EXTRACTORS = {
    "xiaohongshu": r"""
() => {
  const out = [];
  const seen = new Set();
  // 每张笔记卡片是通往 /explore/<id> 或 /search_result/<id> 的链接
  document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]').forEach(a => {
    const m = a.href.match(/\/(explore|search_result)\/([0-9a-zA-Z]+)/);
    if (!m) return;
    const id = m[2];
    if (seen.has(id)) return;
    const card = a.closest('section, .note-item, div') || a;
    const title = (card.querySelector('.title, .footer .title, span, .content')?.innerText || a.innerText || '').trim().slice(0, 80);
    const likeEl = card.querySelector('.like-wrapper .count, .count, .like-count');
    const author = (card.querySelector('.author .name, .name, .user-name')?.innerText || '').trim();
    if (!title) return;
    seen.add(id);
    out.push({ content_id: id, title, url: 'https://www.xiaohongshu.com/explore/' + id,
               likes: (likeEl?.innerText || '0').trim(), author });
  });
  return out;
}
""",
    "douyin": r"""
() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href*="/video/"]').forEach(a => {
    const m = a.href.match(/\/video\/(\d+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    const card = a.closest('li, .search-result-card, div') || a;
    const title = (card.querySelector('[data-e2e="search-result-title"], .title, span')?.innerText || a.innerText || '').trim().slice(0, 80);
    const likeEl = card.querySelector('[data-e2e="video-like-count"], .like, .count');
    const author = (card.querySelector('[data-e2e="search-card-user-name"], .author, .name')?.innerText || '').trim();
    if (!title) return;
    seen.add(id);
    out.push({ content_id: id, title, url: 'https://www.douyin.com/video/' + id,
               likes: (likeEl?.innerText || '0').trim(), author });
  });
  return out;
}
""",
    "bilibili": r"""
() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href*="/video/BV"]').forEach(a => {
    const m = a.href.match(/\/video\/(BV[0-9a-zA-Z]+)/);
    if (!m) return;
    const id = m[1];
    if (seen.has(id)) return;
    const card = a.closest('.bili-video-card, .video-item, li, div') || a;
    const title = (card.querySelector('.bili-video-card__info--tit, h3, .title')?.innerText || a.getAttribute('title') || a.innerText || '').trim().slice(0, 80);
    const stats = card.querySelectorAll('.bili-video-card__stats--item span, .stat, .count');
    const author = (card.querySelector('.bili-video-card__info--author, .up-name, .author')?.innerText || '').trim();
    if (!title) return;
    seen.add(id);
    out.push({ content_id: id, title, url: 'https://www.bilibili.com/video/' + id,
               plays: (stats[0]?.innerText || '0').trim(), comments: (stats[1]?.innerText || '0').trim(), author });
  });
  return out;
}
""",
    "kuaishou": r"""
() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href*="/short-video/"], a[href*="/f/"]').forEach(a => {
    const m = a.href.match(/\/(short-video|f)\/([0-9a-zA-Z_-]+)/);
    if (!m) return;
    const id = m[2];
    if (seen.has(id)) return;
    const card = a.closest('li, .card, div') || a;
    const title = (card.querySelector('.title, .desc, span')?.innerText || a.innerText || '').trim().slice(0, 80);
    const likeEl = card.querySelector('.like, .count');
    const author = (card.querySelector('.author, .name')?.innerText || '').trim();
    if (!title) return;
    seen.add(id);
    out.push({ content_id: id, title, url: 'https://www.kuaishou.com/short-video/' + id,
               likes: (likeEl?.innerText || '0').trim(), author });
  });
  return out;
}
""",
}


def ab(session: str, *args: str, timeout: int = 90) -> subprocess.CompletedProcess:
    """跑一条 agent-browser 命令。"""
    return subprocess.run(["agent-browser", "--session", session, *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def ab_eval(session: str, expr: str, timeout: int = 60):
    """agent-browser eval 只吃【表达式】(不吃 ()=>{} 箭头函数)：这里把箭头函数体
    包成 IIFE 再跑，并从 --json 输出里取 data.result。失败返回 None。"""
    iife = f"({expr})()" if expr.strip().startswith("()") else expr
    r = ab(session, "--json", "eval", iife, timeout=timeout)
    try:
        return json.loads(r.stdout).get("data", {}).get("result")
    except Exception:
        return None


def page_text(session: str) -> str:
    r = ab_eval(session, "() => document.body ? document.body.innerText.slice(0, 4000) : ''")
    return r if isinstance(r, str) else ""


def collect_platform(session: str, platform: str, keyword: str, scrolls: int, per: int) -> dict:
    url = SEARCH_URL.get(platform)
    if not url:
        return {"items": [], "needs_login": False, "error": f"暂不支持平台 {platform}"}
    ab(session, "--headed", "open", url.format(kw=quote(keyword)), timeout=90)
    time.sleep(4)
    txt = page_text(session)
    if any(sig in txt for sig in LOGIN_WALL.get(platform, [])):
        return {"items": [], "needs_login": True,
                "error": f"{platform} 需要登录：请在已打开的窗口里登录后重跑"}
    for _ in range(max(0, scrolls)):
        ab(session, "scroll", "down", "2000")
        time.sleep(1.5)
    items = ab_eval(session, EXTRACTORS[platform])
    if not isinstance(items, list):
        items = []
    return {"items": items[:per], "needs_login": False,
            "error": "" if items else "未提取到条目(选择器需校准或结果未加载)"}


def main():
    ap = argparse.ArgumentParser(description="内置浏览器爆款采集器（绕 API）")
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--platforms", default="xiaohongshu,douyin")
    ap.add_argument("--out", required=True)
    ap.add_argument("--session", default=SESSION_DEFAULT)
    ap.add_argument("--scrolls", type=int, default=6)
    ap.add_argument("--per", type=int, default=20)
    a = ap.parse_args()

    result: dict[str, list] = {}
    report = []
    for p in [x.strip() for x in a.platforms.split(",") if x.strip()]:
        try:
            r = collect_platform(a.session, p, a.keyword, a.scrolls, a.per)
        except subprocess.TimeoutExpired:
            r = {"items": [], "needs_login": False, "error": f"{p} 采集超时"}
        result[p] = r["items"]
        report.append({"platform": p, "count": len(r["items"]),
                       "needs_login": r["needs_login"], "note": r.get("error", "")})

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({"out": a.out, "report": report,
                      "total": sum(len(v) for v in result.values())},
                     ensure_ascii=False, indent=2))
    # 有平台需登录 → 退出码 2，方便上层提示用户
    sys.exit(2 if any(x["needs_login"] for x in report) else 0)


if __name__ == "__main__":
    main()
