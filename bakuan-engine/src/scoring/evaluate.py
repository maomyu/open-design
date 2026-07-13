"""把一条内容跑完整评分：数据分项(程序) + 内容/意图分项(模型) → 双通道分 + 榜单。

对应主链路 步骤5 爆款评分。严格遵循"数据分项由程序算、内容分项由模型给"的原则。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from src.adapters.normalize import RawContent
from src.llm import prompts, router
from src.scoring import hot_score as H


def _norm(x: float, cap: float) -> float:
    """把绝对量压到 0~1（对数归一，避免大 V 一家独大）。"""
    if x <= 0:
        return 0.0
    return min(1.0, math.log10(1 + x) / math.log10(1 + cap))


@dataclass
class Evaluation:
    content_id: str
    traffic: float
    intent: float
    traffic_grade: str
    intent_grade: str
    reason: str
    top_questions: list[str]
    pain_level: int
    recommend_service: str
    detail: dict


def evaluate(rc: RawContent, *, transcript: str = "", comments: list[str] | None = None,
             account_recent_likes: list[int] | None = None,
             keyword_sample_likes: list[int] | None = None,
             growth_per_hour: float | None = None) -> Evaluation:
    comments = comments or []

    # ── 流量爆款分：数据类维度(程序)。数据缺失 → None(交给可用权重归一化)，不算 0 ──
    interaction = None
    if rc.plays or rc.likes:
        denom = max(rc.plays, rc.likes, 1)
        interaction = min(1.0, (rc.collects + rc.comments + rc.shares) / denom * 5)
    account_excess = None   # 未采集账号近作品时视为缺失，不惩罚
    if account_recent_likes and len(account_recent_likes) >= H.S.ANOMALY_MIN_WORKS:
        import statistics
        med = statistics.median(account_recent_likes)
        if med > 0:
            account_excess = min(1.0, (rc.likes / med) / H.S.ANOMALY_S)
    growth = _norm(growth_per_hour, 5000) if growth_per_hour is not None else None

    # ── 流量爆款分：内容类维度(模型) ──
    cdims = router.chat_json(
        [{"role": "system", "content": prompts.CONTENT_DIM_SYS},
         {"role": "user", "content": prompts.content_dims_user(rc.title, transcript)}],
        tier="mid")

    traffic_dims = {
        "data_heat": _norm(max(rc.likes, rc.plays), 200_000),
        "growth": growth,
        "interaction": interaction,
        "account_excess": account_excess,
        "topic_match": float(cdims.get("topic_match", 0.5) or 0.5),
        "structure": float(cdims.get("structure", 0.5) or 0.5),
    }
    traffic_dims = {k: v for k, v in traffic_dims.items() if v is not None}
    traffic, tdetail = H.traffic_score(traffic_dims)

    # ── 精准意向分：评论意图(模型) + 互动密度(程序) ──
    top_questions: list[str] = []
    pain_level = 0
    recommend_service = ""
    intent_dims: dict[str, float] = {}
    if comments:
        idims = router.chat_json(
            [{"role": "system", "content": prompts.INTENT_SYS},
             {"role": "user", "content": prompts.intent_user(comments)}], tier="mid")
        top_questions = idims.get("top_questions", []) or []
        pain_level = int(idims.get("pain_level", 0) or 0)
        recommend_service = str(idims.get("recommend_service", "") or "")
        intent_dims = {k: float(idims.get(k, 0) or 0) for k in
                       ("ask_help", "method_query", "self_projection",
                        "pain_specific", "save_tendency", "audience_match", "high_ticket")}
        intent_dims["comment_density"] = min(1.0, len(comments) / 200)
    intent, idetail = H.intent_score(intent_dims) if intent_dims else (0.0, {"missing": list(H.S.INTENT_WEIGHTS)})

    _f = lambda x: f"{x:.2f}" if x is not None else "缺失"
    reason = (f"流量{traffic}({H.grade(traffic)})/意向{intent}({H.grade(intent)})；"
              f"数据热度{traffic_dims['data_heat']:.2f}、增速{_f(growth)}、"
              f"账号超额{_f(account_excess)}")
    return Evaluation(
        content_id=rc.content_id, traffic=traffic, intent=intent,
        traffic_grade=H.grade(traffic), intent_grade=H.grade(intent),
        reason=reason, top_questions=top_questions, pain_level=pain_level,
        recommend_service=recommend_service,
        detail={"traffic": tdetail, "intent": idetail})


# ── 5 大榜单分类 ──
def classify_boards(ev: Evaluation) -> list[str]:
    boards = []
    if ev.traffic >= 65:
        boards.append("流量爆款榜")
    if ev.intent >= 65:
        boards.append("精准需求榜")
    if ev.intent >= 75:
        boards.append("高咨询意向榜")
    if ev.traffic >= 75 and ev.intent >= 75:
        boards.append("双高榜")
    if ev.pain_level >= 4 and ev.traffic < 75:
        boards.append("新兴小众需求榜")
    return boards


def content_type(ev: Evaluation) -> str:
    hi_t, hi_i = ev.traffic >= 75, ev.intent >= 75
    if hi_t and hi_i:
        return "双高型"
    if hi_i:
        return "精准型"
    return "流量型"
