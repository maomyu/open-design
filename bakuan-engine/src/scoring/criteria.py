"""灵活爆款标准：用户可组合的筛选条件（时间窗 + 多组粉丝/播放/点赞条件）。

设计：一个「标准」= 时间窗 + 若干条「规则」，条目命中 = 在时间窗内 且 命中任一规则
（规则间 OR）；单条规则 = 其所有条件都满足（条件间 AND）。这样能表达：
  - 低粉爆款：{fans_max: 3000, plays_min: 100000}
  - 高粉大爆：{fans_min: 5000, plays_min: 500000}
  - 高赞：{likes_min: 50000}
  - 低粉高赞粉比：{fans_max: 5000, like_rate_min: 5}
多条规则一起传即「或」组合，非常灵活。AI（爆款雷达技能）把用户口语转成这个 JSON。

JSON 形状（--criteria 传字符串或 @文件）：
  {
    "time_window": "7d" | "30d" | "180d" | "all",
    "rules": [
      {"fans_min":0,"fans_max":3000,"plays_min":100000,"likes_min":0,
       "comments_min":0,"like_rate_min":0.0, "label":"低粉爆款"},
      ...
    ]
  }
条件键（都可选）：fans_min/fans_max/plays_min/plays_max/likes_min/likes_max/
comments_min/collects_min/like_rate_min(点赞/粉丝)。label 可选，用于命中理由。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

_WINDOW_SECONDS = {"1d": 86_400, "7d": 604_800, "30d": 2_592_000,
                   "90d": 7_776_000, "180d": 15_552_000, "365d": 31_536_000}


def window_seconds(w: str | None) -> int:
    """时间窗字符串 → 秒；'all'/空/未知 = 0（不限时间）。"""
    if not w or w == "all":
        return 0
    return _WINDOW_SECONDS.get(str(w).strip(), 0)


@dataclass
class Metrics:
    """一条内容参与标准判定的指标（RawContent 的子集，便于测试）。"""
    fans: int = 0
    plays: int = 0
    likes: int = 0
    comments: int = 0
    collects: int = 0
    publish_time: int = 0


def _rule_hit(m: Metrics, rule: dict[str, Any]) -> bool:
    def ge(v, key):
        return key not in rule or rule[key] in (None, "") or v >= float(rule[key])

    def le(v, key):
        return key not in rule or rule[key] in (None, "") or v <= float(rule[key])

    like_rate = (m.likes / m.fans) if m.fans > 0 else 0.0
    # 播放/点赞统一为「热度」：抖音/小红书/快手只给点赞、B站只给播放,平台各异。plays_min 用两者
    # 较大值判定,这样"低粉爆款(热度≥10万)"在抖音看赞、在B站看播放,跨平台都能正确命中爆款。
    heat = max(m.plays, m.likes)
    return (
        ge(m.fans, "fans_min") and le(m.fans, "fans_max")
        and ge(heat, "plays_min") and le(m.plays, "plays_max")
        and ge(m.likes, "likes_min") and le(m.likes, "likes_max")
        and ge(m.comments, "comments_min") and ge(m.collects, "collects_min")
        and ge(like_rate, "like_rate_min")
    )


def match(m: Metrics, criteria: dict[str, Any], now: int | None = None) -> tuple[bool, str]:
    """返回 (是否命中, 命中理由)。criteria 无 rules 时视为「只按时间窗，全收」。"""
    now = int(now if now is not None else time.time())
    win = window_seconds(criteria.get("time_window"))
    if win and m.publish_time:
        if m.publish_time < now - win:
            return False, ""
    rules = criteria.get("rules") or []
    if not rules:
        return True, "时间窗内"
    for rule in rules:
        if _rule_hit(m, rule):
            return True, str(rule.get("label") or _describe(rule))
    return False, ""


def _describe(rule: dict[str, Any]) -> str:
    parts = []
    if rule.get("fans_max"):
        parts.append(f"粉≤{rule['fans_max']}")
    if rule.get("fans_min"):
        parts.append(f"粉≥{rule['fans_min']}")
    if rule.get("plays_min"):
        parts.append(f"播放≥{rule['plays_min']}")
    if rule.get("likes_min"):
        parts.append(f"赞≥{rule['likes_min']}")
    if rule.get("like_rate_min"):
        parts.append(f"赞粉比≥{rule['like_rate_min']}")
    return "自定标准(" + "·".join(parts) + ")" if parts else "自定标准"
