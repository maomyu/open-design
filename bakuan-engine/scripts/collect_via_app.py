"""通过social-auto【应用内标签】采集各平台真实爆款，输出统一 collect-file（喂引擎 --collect-file）。

这是内置浏览器采集的【首选】路径：采集跑在social-auto桌面端的应用内标签 webview 里，
不弹独立窗口，登录态在标签的持久分区。流程：
  POST /api/media-studio/collect 建采集 job → 桌面端 web 在各平台标签抓卡片回写 →
  这里长轮询 /wait 直到完成 → 把 job.results 落成 {平台:[条目]} 文件。

用法：
  python scripts/collect_via_app.py --keyword "相亲" --platforms xiaohongshu,douyin \
      --out /tmp/collect.json [--daemon http://127.0.0.1:4700] [--scrolls 6] [--per 20]

退出码：0=有数据；2=有平台需登录（已在social-auto标签打开，请扫码后重跑）；1=失败/桌面端离线。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

DEFAULT_DAEMON = os.getenv("OD_DAEMON_URL") or f"http://127.0.0.1:{os.getenv('OD_PORT', '4700')}"


def _req(url: str, method: str = "GET", body: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    ap = argparse.ArgumentParser(description="social-auto应用内标签采集（绕 API，不弹窗）")
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--platforms", default="xiaohongshu,douyin,bilibili")
    ap.add_argument("--out", required=True)
    ap.add_argument("--daemon", default=DEFAULT_DAEMON)
    ap.add_argument("--scrolls", type=int, default=6)
    ap.add_argument("--per", type=int, default=20)
    ap.add_argument("--order", default="hot", choices=["hot", "latest", "comprehensive"],
                    help="排序：hot=最多播放/热度(找爆款默认) latest=最新 comprehensive=综合")
    ap.add_argument("--time-window", default="all",
                    help="时间窗：1d/7d/30d/90d/180d/365d/all")
    ap.add_argument("--pages", type=int, default=3, help="分页平台(如B站)翻几页")
    a = ap.parse_args()
    base = a.daemon.rstrip("/")
    platforms = [p.strip() for p in a.platforms.split(",") if p.strip()]

    try:
        created = _req(f"{base}/api/media-studio/collect", "POST", {
            "keyword": a.keyword, "platforms": platforms,
            "scrolls": a.scrolls, "per": a.per,
            "order": a.order, "timeWindow": a.time_window, "pages": a.pages,
        })
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        detail = e.read().decode()[:200] if hasattr(e, "read") else str(e)
        print(json.dumps({"error": f"建采集任务失败({e.code})：{detail}",
                          "hint": "桌面端未连接？请确认social-auto桌面应用在运行。"}, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"连不上social-auto服务：{e}"}, ensure_ascii=False)); sys.exit(1)

    job_id = created.get("job", {}).get("id")
    if not job_id:
        print(json.dumps({"error": "未拿到采集任务 id", "raw": created}, ensure_ascii=False)); sys.exit(1)

    # 长轮询直到终态（各平台标签抓完/超时）。
    since, deadline, job = 0, time.time() + 300, None
    while time.time() < deadline:
        try:
            snap = _req(f"{base}/api/media-studio/collect/{job_id}/wait?since={since}&timeoutMs=25000")
        except Exception:
            time.sleep(2); continue
        job = snap.get("job", {})
        since = snap.get("cursor", since)
        if job.get("status") in ("done", "error"):
            break

    job = job or {}
    results = job.get("results", [])
    out: dict[str, list] = {}
    report = []
    for r in results:
        p = r.get("platform")
        out.setdefault(p, []).extend(r.get("items", []))
        report.append({"platform": p, "count": len(r.get("items", [])),
                       "needs_login": r.get("needsLogin", False), "note": r.get("note", "")})

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    total = sum(len(v) for v in out.values())
    print(json.dumps({"out": a.out, "job": job_id, "status": job.get("status"),
                      "detail": job.get("detail", ""), "total": total, "report": report},
                     ensure_ascii=False, indent=2))
    sys.exit(2 if any(x["needs_login"] for x in report) else (0 if total else 1))


if __name__ == "__main__":
    main()
