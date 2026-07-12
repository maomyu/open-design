"""爆款判定引擎 —— 两阶段 + 双通道（可配置 / 可解释 / 可回测）。

严格按客户《补充需求》实现：
  第一阶段  规则初筛（低成本）：任一命中即进候选池
  第二阶段  双通道评分：流量爆款分 + 精准意向分（0-100）

设计原则：数据分项由程序计算（本文件），内容分项由模型结构化输出（src/llm）。
缺失数据按"可用权重归一化"处理并记录，绝不拿一次 Prompt 拍脑袋。
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Optional

from config import settings as S


@dataclass
class Content:
    """标准化后的一条内容（各平台字段已映射统一）。"""
    content_id: str
    platform: str
    fans: int = 0
    likes: int = 0
    comments: int = 0
    collects: int = 0
    shares: int = 0
    plays: int = 0        # 公众号=阅读数
    publish_hours_ago: Optional[float] = None      # 距发布时长（小时）
    account_recent_likes: list[int] = field(default_factory=list)  # 账号近作品点赞（算异常倍数）
    keyword_sample_likes: list[int] = field(default_factory=list)  # 同关键词近7天样本点赞
    growth_per_hour: Optional[float] = None        # 单位时间点赞增速（由快照算）


# ────────────────────────── 第一阶段：规则初筛 ──────────────────────────

def fans_like_threshold(fans: int) -> int:
    """按粉丝分层返回最低点赞门槛。"""
    for cap, thr in S.FANS_LIKE_THRESHOLDS:
        if fans <= cap:
            return thr
    return S.FANS_LIKE_THRESHOLDS[-1][1]


def prefilter(c: Content) -> list[str]:
    """返回命中的规则名列表；非空即进候选池。每条规则可解释。"""
    hits: list[str] = []

    # 公众号无粉丝数：按阅读量初筛
    if c.platform == "gzh":
        if c.plays >= S.GZH_READ_MIN:
            hits.append("公众号阅读达标")
        return hits

    # 视频号无粉丝/播放数：按综合互动初筛
    if c.platform == "channels":
        if (c.likes + c.collects + c.comments + c.shares) >= S.CHANNELS_ENGAGE_MIN:
            hits.append("视频号互动达标")
        return hits

    # ① 绝对热度（粉丝分层阈值）
    if c.likes >= fans_like_threshold(c.fans):
        hits.append("绝对热度")

    # ①' 播放兜底：浏览器采集只拿到播放没点赞时(如 B站搜索卡片)，高播放也算爆款
    if c.likes == 0 and c.plays >= S.PLAYS_HOT_MIN:
        hits.append("播放达标")

    # ② 低粉高表现
    if (c.fans <= S.LOW_FANS_MAX and c.likes >= S.LOW_FANS_MIN_LIKE
            and c.fans > 0 and c.likes / c.fans >= S.LOW_FANS_LIKE_RATE):
        hits.append("低粉高表现")

    # ③ 账号异常值（相对该账号近作品中位数的倍数）
    if len(c.account_recent_likes) >= S.ANOMALY_MIN_WORKS:
        median = statistics.median(c.account_recent_likes)
        if median > 0:
            ratio = c.likes / median
            if ratio >= S.ANOMALY_S:
                hits.append("账号异常·S级")
            elif ratio >= S.ANOMALY_A:
                hits.append("账号异常·A级")
            elif ratio >= S.ANOMALY_OBSERVE:
                hits.append("账号异常·观察")

    # ④ 关键词头部 Top10%（样本足够时）
    if len(c.keyword_sample_likes) >= S.KEYWORD_MIN_SAMPLE:
        cutoff = _percentile(c.keyword_sample_likes, 1 - S.KEYWORD_TOP_RATIO)
        if c.likes >= cutoff:
            hits.append("关键词头部")

    # ⑤ 快速起量（72h 内且增速进前列，需上游传入 growth_per_hour 排名结果）
    if (c.publish_hours_ago is not None and c.publish_hours_ago <= S.FAST_RISE_HOURS
            and c.growth_per_hour is not None and c.growth_per_hour > 0):
        hits.append("快速起量")

    return hits


# ────────────────────────── 第二阶段：双通道评分 ──────────────────────────

def traffic_score(dims: dict[str, float]) -> tuple[float, dict]:
    """流量爆款分。dims 各维度取值 0-1；数据类维度由程序算、内容类由模型给。

    缺失维度自动从权重中剔除并归一化（记录 missing）。
    """
    return _weighted(dims, S.TRAFFIC_WEIGHTS)


def intent_score(dims: dict[str, float]) -> tuple[float, dict]:
    """精准意向分。dims 由评论意图分析（模型）+ 互动密度（程序）产出。"""
    return _weighted(dims, S.INTENT_WEIGHTS)


def grade(score: float) -> str:
    for name, cut in S.GRADE_CUTOFFS:
        if score >= cut:
            return name
    return "C"   # 低于 65 仅归档


# ────────────────────────── 内部工具 ──────────────────────────

def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    xs = sorted(values)
    k = max(0, min(len(xs) - 1, round(q * (len(xs) - 1))))
    return xs[k]


def _weighted(dims: dict[str, float], weights: dict[str, int]) -> tuple[float, dict]:
    """按权重加权到 0-100；缺失维度剔除并对剩余权重归一化。"""
    present = {k: v for k, v in dims.items() if v is not None and k in weights}
    missing = [k for k in weights if k not in present]
    total_w = sum(weights[k] for k in present) or 1
    score = sum(present[k] * weights[k] for k in present) / total_w * 100
    detail = {
        "score": round(score, 1),
        "dims": {k: round(present[k], 3) for k in present},
        "missing": missing,          # 记录缺失项，满足"可回测/可解释"
    }
    return detail["score"], detail
