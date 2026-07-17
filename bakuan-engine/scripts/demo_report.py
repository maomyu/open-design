"""把 dry-run 产物渲染成可视化 HTML 仪表盘 —— 让客户直观看到成品长什么样。

用法：DRY_RUN=1 python -m src.pipeline --keyword X --dry-run  → python scripts/demo_report.py
产物：docs/demo_report.html（浏览器打开即看：选题池评分 + 生成脚本 + 封面占位）
"""
from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _rows(sink, table):
    return [x["fields"] for x in sink if x["table"] == table]


def build() -> str:
    sink = json.loads((ROOT / "data" / "dryrun_output.json").read_text(encoding="utf-8"))
    pool = _rows(sink, "今日爆款选题池")
    scripts = [f for f in _rows(sink, "成品内容审核库") if f.get("平台标题")]

    def esc(x):
        return html.escape(str(x or ""))

    pool_html = "".join(
        f"<tr><td>{esc(p.get('内容类型'))}</td><td class=score>{esc(p.get('流量爆款分'))}</td>"
        f"<td class=score>{esc(p.get('精准意向分'))}</td><td>{esc(p.get('推荐优先级'))}</td>"
        f"<td>{esc('、'.join(p.get('所属榜单', [])) if isinstance(p.get('所属榜单'), list) else p.get('所属榜单'))}</td>"
        f"<td class=small>{esc(p.get('高频用户问题'))}</td></tr>"
        for p in pool)

    scripts_html = "".join(
        f"<div class=card><h3>{esc(s.get('平台标题'))} <span class=tag>{esc(s.get('平台版本'))}</span></h3>"
        f"<p class=ct>封面标题：{esc(s.get('封面标题候选'))}</p>"
        f"<p>{esc(s.get('60秒脚本'))}</p>"
        f"<p class=small>标签：{esc(s.get('标签'))}　|　引导：{esc(s.get('评论引导'))}</p></div>"
        for s in scripts)

    return f"""<!doctype html><html lang=zh><head><meta charset=utf-8>
<title>自媒体爆款监控 · 成品演示</title><style>
body{{font-family:-apple-system,'PingFang SC',sans-serif;max-width:960px;margin:24px auto;color:#1f2328;padding:0 16px}}
h1{{color:#1F4E79}} h2{{color:#1F4E79;border-bottom:2px solid #e5e7eb;padding-bottom:6px}}
table{{border-collapse:collapse;width:100%;margin:12px 0}} th,td{{border:1px solid #e5e7eb;padding:8px;text-align:left;font-size:14px}}
th{{background:#1F4E79;color:#fff}} .score{{font-weight:700;color:#d83931}} .small{{font-size:12px;color:#666}}
.card{{border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:12px 0;background:#fafbfc}}
.tag{{background:#1F4E79;color:#fff;font-size:12px;padding:2px 8px;border-radius:10px}} .ct{{color:#d83931}}
.note{{background:#fff8e6;border:1px solid #ffe08a;padding:10px;border-radius:6px;font-size:13px}}</style></head><body>
<h1>自媒体爆款监控 · 成品演示（离线 dry-run 生成）</h1>
<p class=note>本页由离线假数据跑通全链路后生成，用于直观展示成品形态。</p>
<h2>① 今日爆款选题池（{len(pool)} 条）</h2>
<table><tr><th>类型</th><th>流量爆款分</th><th>精准意向分</th><th>优先级</th><th>所属榜单</th><th>高频用户问题</th></tr>{pool_html}</table>
<h2>② 生成的口播脚本（{len(scripts)} 份，仿写×自有风格）</h2>
{scripts_html}
</body></html>"""


def main():
    out = ROOT / "docs" / "demo_report.html"
    out.write_text(build(), encoding="utf-8")
    print(f"已生成 {out}")


if __name__ == "__main__":
    main()
