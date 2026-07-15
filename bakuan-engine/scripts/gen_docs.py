"""从代码生成《数据字典》与《系统全参数配置对照表》，保证文档与代码完全一致。

运行：python scripts/gen_docs.py  → 覆盖 docs/数据字典.md、docs/系统全参数配置对照表.md
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.modules.setdefault("dotenv", types.SimpleNamespace(load_dotenv=lambda *a, **k: None))

from config import settings as S           # noqa: E402
from src.feishu.tables import TABLES        # noqa: E402


def gen_data_dict() -> str:
    lines = ["# 数据字典（飞书 12 张逻辑表）", "",
             "> 本文件由 `scripts/gen_docs.py` 从 `src/feishu/tables.py` 自动生成，保证与代码一致。", ""]
    for name, spec in TABLES.items():
        lines.append(f"## {name}（{spec['stage']}）")
        lines.append(f"> {spec['desc']}")
        lines.append("")
        lines.append("| 字段 | 类型 |")
        lines.append("|------|------|")
        for fname, ftype in spec["fields"]:
            lines.append(f"| {fname} | {ftype} |")
        lines.append("")
    return "\n".join(lines)


def gen_param_table() -> str:
    rows = [
        ("粉丝分层点赞阈值", "config/settings.py:FANS_LIKE_THRESHOLDS", str(S.FANS_LIKE_THRESHOLDS), "改分层门槛", "重启生效"),
        ("低粉高表现·粉丝上限", "settings.LOW_FANS_MAX", S.LOW_FANS_MAX, "≤此粉丝算低粉", "重启"),
        ("低粉高表现·最低点赞", "settings.LOW_FANS_MIN_LIKE", S.LOW_FANS_MIN_LIKE, "低粉门槛", "重启"),
        ("低粉高表现·赞粉比", "settings.LOW_FANS_LIKE_RATE", S.LOW_FANS_LIKE_RATE, "点赞/粉丝≥", "重启"),
        ("账号异常·作品数下限", "settings.ANOMALY_MIN_WORKS", S.ANOMALY_MIN_WORKS, "<此不收录", "重启"),
        ("账号异常·观察/A/S 倍数", "settings.ANOMALY_*", f"{S.ANOMALY_OBSERVE}/{S.ANOMALY_A}/{S.ANOMALY_S}", "相对中位数倍数", "重启"),
        ("关键词头部比例", "settings.KEYWORD_TOP_RATIO", S.KEYWORD_TOP_RATIO, "Top 比例", "重启"),
        ("关键词最小样本", "settings.KEYWORD_MIN_SAMPLE", S.KEYWORD_MIN_SAMPLE, "启用 Top 的样本量", "重启"),
        ("快速起量窗口(h)", "settings.FAST_RISE_HOURS", S.FAST_RISE_HOURS, "发布时长窗口", "重启"),
        ("流量爆款分权重", "settings.TRAFFIC_WEIGHTS", str(S.TRAFFIC_WEIGHTS), "6 维权重", "重启"),
        ("精准意向分权重", "settings.INTENT_WEIGHTS", str(S.INTENT_WEIGHTS), "8 维权重", "重启"),
        ("分级门槛", "settings.GRADE_CUTOFFS", str(S.GRADE_CUTOFFS), "S/A/B 门槛", "重启"),
        ("检测频率(分)", ".env:DEFAULT_DETECT_INTERVAL_MIN", "环境变量", "定时频率", "重启调度器"),
        ("RAG TopK", ".env:RAG_TOPK", "环境变量", "召回条数", "下次生成"),
        ("生图模型", ".env:IMAGE_MODEL", "doubao-seedream-5.0", "封面背景模型", "下次生成"),
        ("文本三层模型", ".env:LLM_TIER_LOW/MID/HIGH", str(S.LLM_TIERS), "低/中/高层模型别名", "下次调用/热切"),
    ]
    out = ["# 系统全参数配置对照表", "",
           "> 由 `scripts/gen_docs.py` 从 `config/settings.py` 与 `.env` 自动生成。",
           "> 阈值/权重也可在飞书「系统配置表」运行期覆盖。", "",
           "| 配置项 | 存储位置 | 默认值 | 修改范围 | 生效方式 |",
           "|------|------|------|------|------|"]
    for name, loc, val, scope, effect in rows:
        out.append(f"| {name} | `{loc}` | {val} | {scope} | {effect} |")
    return "\n".join(out)


def main():
    (ROOT / "docs" / "数据字典.md").write_text(gen_data_dict(), encoding="utf-8")
    (ROOT / "docs" / "系统全参数配置对照表.md").write_text(gen_param_table(), encoding="utf-8")
    print("已生成 docs/数据字典.md、docs/系统全参数配置对照表.md")


if __name__ == "__main__":
    main()
